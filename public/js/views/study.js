/* 学习 —— 翻卡片。
 *
 * 两种模式**互不混合**（由路由决定）：
 *   #/study   mode='new'    学新词：一次给 batch_size 个，一批全部过关再进下一批
 *   #/review  mode='review' 复习：只取到期的词，批内按错误次数从多到少排
 *
 * 过关规则（两种模式一致）：
 *   点「认识」或「模糊」＝过关（认识 → 下次间隔大步推进；模糊 → 只推一档）；
 *   点「不认识」＝错词，把它在队列里**搬家**、隔 3~5 张再考，直到点会为止。
 *
 * 排期走三阶段协议（服务端 /api/study/answer 的 phase 参数）：
 *   first  本轮第一次作答 —— 只记流水，**不排期**
 *   repeat 本轮重复作答   —— 只记流水，不进正确率、不进打卡
 *   pass   本轮过关       —— 这时候才按**第一次作答**的质量排期
 * 为什么要延到过关才排期：不认识的词会被重复到会为止，如果第一次不认识就
 * 打回阶段 0，那「重复到会了」这件事就白费了。
 *
 * 关于统计：
 *   正确率只记「第一次作答」（与服务端口径一致），重复作答单独累计并在批次结束时展示。
 */
(function () {
  'use strict';

  const U = window.UI;

  /** 路由名 → 模式。同一个视图挂两个路由 */
  const MODE_OF = { study: 'new', review: 'review' };
  const GAP_MIN = 3;            // 错词搬回队列时至少隔几张
  const GAP_MAX = 5;            // 最多隔几张

  /** 反馈值 → 中文，用于「首次是『不认识』」这类提示 */
  const RATING_CN = { known: '认识', vague: '模糊', unknown: '不认识' };

  const state = {
    mode: 'new',
    cards: [],                  // 本批卡片，每张带 _seq / _first / _repeats / _done / _archived
    idx: 0,
    flipped: false,
    busy: false,
    bookCode: '',
    batchSize: 5,
    batchNo: 1,
    // 以下字段与 /api/study/plan 的返回同名，避免「赋值用 A、读取用 B」这类笔误
    newAvail: 0,                // 词库里还没学过的词还有多少
    newLearned: 0,              // 今天已经学了多少新词（进入本批那一刻的后端值）
    dailyNew: 0,                // 今日新词目标（仅用于展示，不是硬上限）
    overGoal: false,
    learnedAtBatchStart: 0,     // 本批开始时后端记的「今日已学」，用来算 learnedToday
    batchesLeft: 0,
    dueTotal: 0,
    stats: { firstKnown: 0, firstVague: 0, firstUnknown: 0, repeats: 0, words: 0 },
    startedAt: Date.now(),
    loading: false,
  };

  let keyHandler = null;


  async function render(el, params, routeName = 'study') {
    // 模式由**路由名**决定（study / review），不读 params.mode ——
    // #/review 没有 query，读 params.mode 永远拿到 undefined，会被误判成学新词。
    const isNew = (MODE_OF[routeName] || 'new') === 'new';
    state.mode = isNew ? 'new' : 'review';
    state.bookCode = params.book || window.App.state.book?.code || 'cet4';
    state.batchSize = 5;
    state.batchNo = 1;
    state.newAvail = 0;
    state.newLearned = 0;
    state.dailyNew = 0;
    state.overGoal = false;
    state.batchesLeft = 0;
    state.dueTotal = 0;
    state.stats = { firstKnown: 0, firstVague: 0, firstUnknown: 0, repeats: 0, words: 0 };
    state.startedAt = Date.now();
    state.loading = false;

    window.App._cleanup = () => { reportTime(); };

    el.innerHTML = `
      <div class="study-shell">
        <div class="study-top">
          <button class="btn btn-sm btn-ghost" id="exit">${U.icon('arrowLeft')} 返回今日</button>
          <div class="study-counter" id="counter"></div>
          <span class="spacer"></span>
          <span class="chip" style="background:transparent;border-color:${isNew ? 'var(--info)' : 'var(--accent)'};color:${isNew ? 'var(--info)' : 'var(--accent)'}">
            ${isNew ? '学新词' : '复习'}
          </span>
          <select class="select" id="book-select" style="width:auto;min-width:140px">
            ${window.App.state.books.map((b) => `
              <option value="${b.code}" ${b.code === state.bookCode ? 'selected' : ''}>
                ${U.esc(b.short_name)}
              </option>`).join('')}
          </select>
        </div>
        <div class="flip-wrap">
          <div class="flip" id="flip">
            <div class="flip-face flip-front" id="front"></div>
            <div class="flip-face back" id="back"></div>
          </div>
          <div class="grades" id="grades">
            <div class="grade-row" id="grade-row"></div>
          </div>
        </div>
        <div id="progress" class="bar"></div>
      </div>`;

    const flip = document.getElementById('flip');
    const front = document.getElementById('front');
    const back = document.getElementById('back');
    const grades = document.getElementById('grades');
    const counter = document.getElementById('counter');
    const prog = document.getElementById('progress');

    document.getElementById('exit').addEventListener('click', () => {
      window.App.go('#/today');
    });

    document.getElementById('book-select').addEventListener('change', (e) => {
      state.bookCode = e.target.value;
      load();
    });

    // 点击卡片翻转
    flip.addEventListener('click', () => {
      if (state.busy) return;
      state.flipped = !state.flipped;
      syncFlipFace(flip, grades);
    });

    // 评分按钮
    grades.addEventListener('click', (e) => {
      const btn = e.target.closest('.grade-btn');
      if (!btn || state.busy) return;
      grade(btn.dataset.g);
    });

    // 键盘快捷键
    keyHandler = (e) => {
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!state.flipped) {
          state.flipped = true;
          syncFlipFace(flip, grades);
        }
      } else if (state.flipped && ['1', '2', '3'].includes(e.key)) {
        const map = { '1': 'unknown', '2': 'vague', '3': 'known' };
        grade(map[e.key]);
      }
    };
    document.addEventListener('keydown', keyHandler);

    await load();
  }

  /**
   * 给一批原始词条挂上本轮需要的临时状态。
   *
   * 注意 `_done` / `_repeats` / `_archived` 都挂在**卡片对象**上，
   * 而队列里每个词只会有一个对象（见 repel()），所以不需要额外的副本管理。
   */
  let seqCounter = 0;
  function decorate(words) {
    seqCounter = 0;
    return (words || []).map((w) => ({
      ...w,
      _seq: ++seqCounter,   // 首次进入本轮的顺序号，用于「本批 N / M」的稳定显示
      _first: null,         // 第一次作答的选择
      _repeats: 0,          // 这个词本轮被重复考了几次（不含第一次）
      _done: false,         // 是否已过关
      _archived: false,     // 过关结果是否已经提交给服务端（防止重复归档）
    }));
  }

  /**
   * 取一批词。
   * @param {boolean} ignoreLimit 复习模式专用：忽略「今日目标」也要再刷一遍
   *   学新词永远不设硬上限 —— 词库还有没学过的就继续给。
   */
  async function fetchBatch(ignoreLimit = false) {
    const isNew = state.mode === 'new';
    const res = await API.plan(state.bookCode, {
      mode: isNew ? 'new' : 'review',
      ignoreLimit,
    });
    if (isNew) {
      state.newAvail = res.newAvail || 0;
      state.batchesLeft = res.batchesLeft || 0;
      state.batchSize = res.batchSize || state.batchSize;
      // 今日进度（来自 counters，用于「今日已学新词 N 个」这行）
      const c = res.counters || {};
      state.newLearned = c.newLearned || 0;
      state.dailyNew = c.dailyNew || 0;
      state.overGoal = !!res.overGoal;
      // 记住这一批的起点，完成面板用它 + 本批答过的词数算「今日已学」
      state.learnedAtBatchStart = state.newLearned;
      return res.news || [];
    }
    state.dueTotal = (res.pools && res.pools.dueTotal) || 0;
    return res.queue || [];
  }

  /**
   * 取下一批（「继续下一批」/「再刷一遍」）：清空本轮统计，重新开一批。
   * @param {boolean} ignoreLimit 复习时忽略今日目标，硬再刷一轮
   */
  async function loadNextBatch(ignoreLimit = false) {
    const words = await fetchBatch(ignoreLimit);
    state.cards = decorate(words);
    state.idx = 0;
    state.flipped = false;
    state.batchNo += 1;
    state.stats = { firstKnown: 0, firstVague: 0, firstUnknown: 0, repeats: 0, words: 0 };
    const flip = document.getElementById('flip');
    if (flip) flip.classList.remove('flipped');
    return state.cards.length;
  }

  async function load() {
    const isNew = state.mode === 'new';
    const counter = document.getElementById('counter');
    const prog = document.getElementById('progress');
    const grades = document.getElementById('grades');
    if (!counter) return;
    counter.innerHTML = `<span>${isNew ? '正在加载新词…' : '正在加载复习…'}</span>`;
    if (grades) { grades.style.opacity = '0'; grades.style.pointerEvents = 'none'; }

    try {
      const cards = await fetchBatch(false);

      if (!cards || !cards.length) {
        state.cards = [];
        state.idx = 0;
        paintEmpty(prog, counter);
        return;
      }

      state.cards = decorate(cards);
      state.idx = 0;
      state.flipped = false;
      paint();
    } catch (err) {
      console.error('[study] 加载失败', err);
      // 把真实原因显示出来 —— 只写「加载失败，请重试」的话，
      // 到底是服务没开、还是接口报错、还是字段缺失，用户完全无从判断。
      const reason = (err && err.message) ? err.message : String(err);
      counter.innerHTML = `<span style="color:var(--bad)">加载失败：${U.esc(reason)}</span>`;
      if (prog) {
        prog.innerHTML = `<span style="color:var(--text-dim);font-size:13px">
          请确认服务仍在运行（地址栏端口要和启动窗口显示的端口一致），然后刷新页面重试。
        </span>`;
      }
    }
  }

  function current() {
    return state.cards[state.idx] || null;
  }

  function syncFlipFace(flip, grades) {
    if (!flip) return;
    flip.classList.toggle('flipped', state.flipped);
    if (grades) {
      grades.style.opacity = state.flipped ? '1' : '0';
      grades.style.pointerEvents = state.flipped ? 'auto' : 'none';
    }
  }

  /**
   * 本轮重复：把同一个对象在队列里**搬家**，而不是复制一份。
   *
   * 以前是 `splice(idx + gap, 0, w)` —— 插进去的**和当前这张是同一个对象引用**。
   * 由于 `_done` 挂在那个对象上，等轮到副本时它已经是「已过关」，
   * 而 `paint()` 又不会跳过已过关的卡，于是：
   *   · 一个词被要求作答 3 次
   *   · `unknown_count` 被多计（它是顽固词阈值和复习队列排序的输入）
   *   · 多出一条流水
   * 实测呈现顺序变成 A → A → B → C → D → A[已过关] → E（5 个词显示成 6 个）。
   *
   * 正确做法：先把它从当前位置**摘掉**，再插到后面 —— 队列里始终只有一份。
   * 这样 `state.idx` 不用动（摘掉之后，原来的下标自然指向下一张卡）。
   */
  function repel(w, gap) {
    const from = state.cards.indexOf(w);
    if (from < 0) return;
    state.cards.splice(from, 1);
    // 摘掉之后后面的元素整体前移 1 位，所以要减 1 才是原来的相对距离
    const to = Math.max(from + 1, Math.min(from + gap - 1, state.cards.length));
    state.cards.splice(to, 0, w);
  }

  /**
   * 前进到下一张「还没过关」的卡。
   *
   * 用 while 跳过已过关的卡，而不是简单 `idx++` —— 搬家之后队列顺序会变，
   * 靠计数前进迟早会撞上已过关的卡（那正是以前「已过关的卡又出现一次」的原因）。
   */
  function nextCard() {
    while (state.idx < state.cards.length && state.cards[state.idx]._done) state.idx += 1;
    return state.idx < state.cards.length;
  }

  async function grade(g) {
    const w = current();
    if (!w || state.busy || w._done) return;
    state.busy = true;

    const isKnown = g === 'known';
    const isVague = g === 'vague';

    /*
     * 三阶段协议（服务端 src/routes/study.js 的 /answer 已经实现好了）：
     *   first   —— 这个词本轮的**第一次**作答。只记流水，**不排期**。
     *   repeat  —— 本轮里的重复作答。只记流水，不进正确率、不进打卡。
     *   pass    —— 本轮过关。这时候才按「第一次作答」的质量排期。
     *
     * 为什么要延到过关才排期（这是原设计，不是新加的）：
     *   不认识的词会被重复到会为止。如果第一次不认识就打回阶段 0，
     *   那「重复到会了」这件事就白费了。
     *
     * 以前前端固定发 'legacy'，于是服务端的 first/repeat 分支全是死代码，
     * 连带三个后果：每次点反馈都排期一次、重复作答也算进正确率、
     * 「今日已复习」因为只认 card_done 而**恒为 0**。
     */
    const isFirst = w._first === null;
    if (isFirst) w._first = g;
    else w._repeats += 1;

    // 识别 → 过关；不认识 → 插回队列隔 3~5 张再考
    if (isKnown || isVague) w._done = true;

    // 提交作答
    try {
      if (isFirst) {
        await API.answer(w.id, g, state.bookCode, 'first', g);
      } else {
        await API.answer(w.id, g, state.bookCode, 'repeat', w._first);
      }
    } catch (e) { /* 静默：网络抖动不该打断学习，过关时还会再提交一次 */ }

    // 过关归档：只有这里才真正排期
    if (w._done && !w._archived) {
      w._archived = true;
      try {
        await API.answer(w.id, g, state.bookCode, 'pass', w._first);
      } catch (e) { /* 静默 */ }
    }

    // 本轮统计（正确率口径 = 只看第一次作答，与服务端一致）
    if (isFirst) {
      state.stats.firstKnown += (isKnown ? 1 : 0);
      state.stats.firstVague += (isVague ? 1 : 0);
      state.stats.firstUnknown += (!isKnown && !isVague ? 1 : 0);
      state.stats.words += 1;
    } else {
      state.stats.repeats += 1;
    }

    if (!w._done) {
      const gap = Math.min(GAP_MAX, GAP_MIN + Math.floor(Math.random() * 3));
      repel(w, gap);
    }

    showFeedback(w, g);

    setTimeout(() => {
      state.busy = false;
      if (w._done) nextCard();
      if (state.idx >= state.cards.length) {
        paintBatchDone(document.getElementById('progress'), document.getElementById('counter'));
        return;
      }
      state.flipped = false;
      paint();
    }, 600);
  }
  /**
   * 在真题例句里把当前单词高亮出来。
   *
   * 例句来自真题原文，可能带 * 号、括号、中文注释等杂物，
   * 所以流程是：**先在原文上做匹配 → 再逐段转义 → 拼回高亮标签**。
   * 这样既不会被转义出来的实体（&#39; &amp; 等）干扰匹配，
   * 也不会让原文里的尖括号跑进 HTML。
   *
   * 词形回落：reveal / revealed / reveals / revealing / revealment 都能命中。
   */
  function highlightWord(sentence, word) {
    const text = String(sentence ?? '');
    if (!word) return U.esc(text);

    // 在**未转义**的原文上建正则，避免实体字符干扰词边界
    const stem = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b(${stem}(?:s|es|ed|d|ing|ly)?)\\b`, 'gi');

    // split + 捕获组：偶数下标是普通文本，奇数下标是命中的词
    const pieces = text.split(re);
    return pieces
      .map((p, i) => (i % 2 === 1 ? `<mark class="hl-word">${U.esc(p)}</mark>` : U.esc(p)))
      .join('');
  }

  function paint() {
    const flip = document.getElementById('flip');
    const front = document.getElementById('front');
    const back = document.getElementById('back');
    const grades = document.getElementById('grades');
    const counter = document.getElementById('counter');
    const prog = document.getElementById('progress');
    if (!flip) return;

    const cards = state.cards;

    if (!cards.length) {
      paintEmpty(prog, counter);
      return;
    }
    if (state.idx >= cards.length) {
      paintBatchDone(prog, counter);
      return;
    }

    const w = current();
    const total = cards.length;

    /*
     * 进度用 `_seq`（首次进入本轮的顺序号）算，而不是 `idx` 或「已完成数」——
     * 错词会被搬到队列后面，按位置算的话进度条会来回跳。
     * `_seq` 在 decorate() 里递增分配，是稳定的。
     */
    const seen = cards.filter((c) => c._seq <= w._seq).length;
    const isNew = state.mode === 'new';

    counter.innerHTML = `
      <span>本批 <b>${Math.min(seen, total)}</b> / ${total}</span>
      <span class="sep">·</span>
      <span>${isNew ? `第 ${state.batchNo} 批新词` : '复习'}</span>
      ${w._repeats ? `<span class="sep">·</span>
        <span>重复第 ${w._repeats} 次</span>` : ''}
    `;
    prog.style.width = `${(done / total) * 100}%`;
    var gradeRow = document.getElementById("grade-row");
    if (gradeRow) {
      gradeRow.innerHTML = "";
      var buttons = [
        { g: "unknown", label: "不认识" },
        { g: "vague", label: "模糊" },
        { g: "known", label: "认识" },
      ];
      buttons.forEach(function(b) {
        var btn = document.createElement("button");
        btn.className = "grade-btn";
        /*
         * 两个属性都要设：
         *   data-g      —— 点击事件读它（btn.dataset.g）
         *   data-rating —— CSS 的悬停变色读它（.grade-btn[data-rating="..."]:hover）
         *
         * 以前只设了 data-g，而 app.css 里写的是 [data-rating="..."]，
         * 选择器对不上，那三条 hover 变色规则**从来没有生效过**；
         * 同时这行还内联写死了 #e5e7eb / #fff / #374151（浅色系），
         * 于是深色主题下这三颗按钮永远是一块白底。现在交给 CSS。
         */
        btn.dataset.g = b.g;
        btn.dataset.rating = b.g;
        btn.textContent = b.label;
        gradeRow.appendChild(btn);
      });
    }

    const accent = isNew ? 'var(--info)' : 'var(--accent)';

    front.innerHTML = `
      <span class="chip" style="background:transparent;border-color:${accent};color:${accent}">
        ${isNew ? '新词' : '复习'}
      </span>
      <div class="word-main">${U.esc(w.spelling)}</div>
      ${w.phonetic ? `
        <div class="word-phon">
          <button class="speak-btn" id="speak-front" title="朗读">${U.icon('speaker')}</button>
          <span>/${U.esc(w.phonetic)}/</span>
        </div>` : ''}
      ${w.pos ? `<div class="row wrap" style="justify-content:center;gap:6px">
        ${w.pos.split(' ').map((p) => `<span class="chip pos">${U.esc(p)}</span>`).join('')}
      </div>` : ''}
      ${w._repeats ? `<div class="chip" style="background:var(--warn-soft);border-color:transparent;color:var(--warn)">
        再考一次 · 已重复 ${w._repeats} 次${w._first ? ` · 首次是「${RATING_CN[w._first] || w._first}」` : ''}
      </div>` : ''}
      <div class="flip-hint">点击卡片或按 <kbd>空格</kbd> 查看释义</div>
    `;

    const parts = U.splitMeaning(w.meaning);
    back.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div style="min-width:0">
          <div class="word-main small">${U.esc(w.spelling)}</div>
          ${w.phonetic ? `<div class="word-phon" style="margin-top:4px">
            <button class="speak-btn" id="speak-back" title="朗读">${U.icon('speaker')}</button>
            <span>/${U.esc(w.phonetic)}/</span>
          </div>` : ''}
        </div>
        <span class="spacer"></span>
        <div class="row" style="gap:8px">
          ${U.collinsStars(w.collins)}
          ${w.oxford ? '<span class="chip" style="color:var(--info);background:var(--info-soft);border-color:transparent">牛津3000</span>' : ''}
        </div>
      </div>

      <div class="detail-block">
        <div class="lbl">释义</div>
        <div class="meaning-list">
          ${parts.map((p, i) => `
            <div class="meaning-item">
              <span class="idx">${i + 1}</span>
              <span class="txt">${p.pos ? `<em>${U.esc(p.pos)}</em>` : ''}${U.esc(p.text)}</span>
            </div>`).join('')}
        </div>
      </div>

      ${w.phrases && w.phrases.length ? `<div class="detail-block">
        <div class="lbl">常见搭配</div>
        <div class="phrase-list">
          ${w.phrases.map((p) => `<span class="phrase">${U.esc(p)}</span>`).join('')}
        </div>
      </div>` : ''}

      ${w.example ? `<div class="detail-block">
        <div class="lbl">真题例句</div>
        <div class="body quote">${highlightWord(w.example, w.spelling)}</div>
      </div>` : ''}

      ${w.exchange ? `<div class="detail-block">
        <div class="lbl">词形变化</div>
        <div class="body">${U.esc(w.exchange)}</div>
      </div>` : ''}

      ${w.definition ? `<div class="detail-block">
        <div class="lbl">英文释义</div>
        <div class="body">${U.esc(w.definition)}</div>
      </div>` : ''}

      ${w.meaning_alt ? `<div class="detail-block">
        <div class="lbl">专业释义</div>
        <div class="body">${U.esc(w.meaning_alt)}</div>
      </div>` : ''}

      <div class="detail-block" id="note-block">
        <div class="lbl">我的助记</div>
        <textarea class="note-input" id="card-note" rows="1" maxlength="500"
          placeholder="写点自己的记忆法：词根、谐音、场景联想…（失焦自动保存）">${U.esc(w.note || '')}</textarea>
      </div>

      <div class="flip-hint" style="padding-top:14px;position:static;text-align:left;font-size:11.5px">
        ${w.unit_name ? U.esc(w.unit_name) + ' · ' : ''}${w.frq ? `语料库词频 #${w.frq}` : '按反馈自动排期'}
        ${w.reps ? ` · 已复习 ${w.reps} 次` : ''}
        ${!isNew && w.error_score ? ` · 错误分 ${w.error_score}` : ''}
      </div>
    `;

    const speakWord = (e) => {
      e.stopPropagation();
      U.speak(w.spelling, window.App.state.settings.accent);
    };
    const sf = back.querySelector('#speak-back');
    if (sf) sf.addEventListener('click', speakWord);
    const sfr = front.querySelector('#speak-front');
    if (sfr) sfr.addEventListener('click', speakWord);

    /*
     * 卡片背面的助记笔记：失焦即保存。
     *
     * 三个细节：
     *  1. 点输入框不能连带把卡片翻回去（卡片本体绑了翻转）→ stopPropagation
     *  2. 高度随内容长 —— 学的时候写两三行是常事，别出现滚动条
     *  3. 翻到下一张卡时整个 back 会重建，所以「失焦保存」天然在换卡前触发
     */
    const noteEl = back.querySelector('#card-note');
    if (noteEl) {
      const autoGrow = () => { noteEl.style.height = 'auto'; noteEl.style.height = noteEl.scrollHeight + 'px'; };
      autoGrow();
      noteEl.addEventListener('click', (e) => e.stopPropagation());
      noteEl.addEventListener('input', autoGrow);
      noteEl.addEventListener('blur', async () => {
        const val = noteEl.value.trim();
        const before = w.note || '';
        if (val === before) return;
        try {
          const r = await API.saveNote(w.id, val);
          w.note = r.note;                       // 同一张卡再次翻面时显示最新的
          U.toast(r.saved ? '助记已保存' : '助记已清除', 'ok');
        } catch (err) {
          U.toast('助记保存失败：' + err.message, 'bad');
        }
      });
    }

    /*
     * 自动发音：卡片一出现就读，不用再去点喇叭。
     * 由设置里的「自动发音」控制（auto_pronounce）。
     * silent 传 true —— 失败不弹提示打断学习。
     * 重复出现的错词也会重新读一遍，这是有意的（再听一次有助于记）。
     *
     * 浏览器可能以「还没有用户手势」为由拦下第一次朗读（autoplay 策略），
     * 这时在用户下一次点击/按键时补读一次 —— 否则第一张卡永远没声音。
     */
    const isMobile = window.matchMedia('(max-width: 860px)').matches
      || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (!isMobile && window.App.state.settings.auto_pronounce === '1') {
      autoSpeak(w.spelling);
    }

    syncFlipFace(flip, grades);
  }

  /* ------------------------------------------------------------------ */
  /* 自动发音                                                            */
  /* ------------------------------------------------------------------ */

  /** 已经挂过「等用户手势补读」监听的朗读文本，避免重复挂 */
  let armedSpeak = null;

  /**
   * 朗读当前单词。
   *
   * 正常情况下直接读。如果浏览器以「没有用户手势」为由拦下（autoplay 策略），
   * 就挂一组一次性监听：用户下一次点击 / 按键 / 触摸时补读，然后立刻摘掉。
   * 这样第一张卡不会永远静音，也不会在后续每张卡上反复挂监听。
   */
  function autoSpeak(word) {
    if (!word) return;
    const accent = window.App.state.settings.accent;

    U.speak(word, accent, {
      silent: true,
      onBlocked: (why) => {
        // 只有「被 autoplay 拦下」才值得补读；不支持 / 网络错就没必要了
        if (why !== 'not-allowed' && why !== 'NotAllowedError' && why !== 'not-allowed ') return;
        armSpeakRetry(word, accent);
      },
    });
  }

  function armSpeakRetry(word, accent) {
    if (armedSpeak === word) return;   // 同一张卡只补一次
    armedSpeak = word;

    const cleanup = () => {
      document.removeEventListener('click', fire, true);
      document.removeEventListener('keydown', fire, true);
      document.removeEventListener('touchstart', fire, true);
      armedSpeak = null;
    };
    function fire() {
      cleanup();
      U.speak(word, accent, { silent: true });
    }

    // capture 阶段挂上，保证先于卡片自己的 click（翻面）执行
    document.addEventListener('click', fire, true);
    document.addEventListener('keydown', fire, true);
    document.addEventListener('touchstart', fire, true);

    // 兜底：这张卡如果 10 秒内被翻过去看别的词了，别再补读旧词
    setTimeout(() => { if (armedSpeak === word) cleanup(); }, 10000);
  }

  /** 本批没有词可取（词库新词学完 / 没有到期的） */
  function paintEmpty(prog, counter) {
    const flip = document.getElementById('flip');
    const grades = document.getElementById('grades');
    const isNew = state.mode === 'new';

    counter.innerHTML = `<span>${isNew ? '学新词' : '复习'}</span>`;
    prog.style.width = "100%";
    if (grades) { grades.style.opacity = '0'; grades.style.pointerEvents = 'none'; }

    flip.classList.add('done');
    flip.style.transform = 'none';
    document.getElementById('front').style.display = 'none';
    document.getElementById('back').innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:34px;margin-bottom:10px">${isNew ? '🎉' : '✅'}</div>
        <div style="font-size:19px;font-weight:700;margin-bottom:8px">
          ${isNew ? '这个词库的新词都学完了' : '今天没有到期的词'}
        </div>
        <div style="color:var(--text-dim);font-size:13.5px;line-height:1.8">
          ${isNew
            ? `可以换个词库继续，或者去「复习」把学过的巩固一下。`
            : `记忆间隔还没到，按计划明天再来就行。`}
        </div>
        <div class="row" style="justify-content:center;gap:10px;margin-top:18px;flex-wrap:wrap">
          ${isNew ? '<button class="btn" id="p-review">去复习</button>' : '<button class="btn" id="p-new">去学新词</button>'}
          <button class="btn btn-ghost" id="p-home">返回今日</button>
        </div>
      </div>`;
    state.panel = 'empty';

    const goReview = document.getElementById('p-review');
    if (goReview) goReview.addEventListener('click', () => window.App.go('#/review'));
    const goNew = document.getElementById('p-new');
    if (goNew) goNew.addEventListener('click', () => window.App.go('#/study'));
    document.getElementById('p-home').addEventListener('click', () => window.App.go('#/today'));
  }

  /** 本批做完 */
  function paintBatchDone(prog, counter) {
    const flip = document.getElementById('flip');
    const grades = document.getElementById('grades');
    const isNew = state.mode === 'new';
    const s = state.stats;
    const firstTotal = s.firstKnown + s.firstVague + s.firstUnknown;
    const acc = firstTotal ? Math.round((s.firstKnown / firstTotal) * 100) : 0;
    // 学新词没有上限：只要词库里还有没学过的词，就继续给下一批
    const more = isNew && state.newAvail > 0;

    // 今日已学 = 本批开始时的后端值 + 本批真正答过的词数。
    // 不能直接用后端值 —— 它要等这批提交完才更新，面板会显示成上一批的数字；
    // 也不能一直累加本批 —— loadNextBatch 会把后端值刷新成含本批的，会重复计数。
    const learnedToday = state.learnedAtBatchStart + s.words;

    counter.innerHTML = `<span>本批 ${state.cards.length} 个 · 完成</span>`;
    prog.style.width = "100%";
    if (grades) { grades.opacity = '0'; grades.pointerEvents = 'none'; }

    flip.classList.add('done');
    flip.style.transform = 'none';
    document.getElementById('front').style.display = 'none';
    document.getElementById('back').innerHTML = `
      <div style="text-align:center;padding:14px 0">
        <div style="font-size:34px;margin-bottom:8px">${more ? '👏' : '🎉'}</div>
        <div style="font-size:19px;font-weight:700;margin-bottom:6px">
          ${more ? `第 ${state.batchNo} 批全部过关` : (isNew ? '这个词库的新词都学完了' : '今天的复习做完了')}
        </div>
        <div style="color:var(--text-dim);font-size:13.5px;line-height:1.9">
          本批 <b>${state.cards.length}</b> 个词 ·
          第一次答对 <b>${s.firstKnown}</b> · 模糊 ${s.firstVague} · 不认识 ${s.firstUnknown}<br>
          第一次作答正确率 <b>${acc}%</b>${s.repeats ? ` · 另有 <b>${s.repeats}</b> 次重复作答（不计入正确率）` : ''}
        </div>
        ${isNew ? `<div style="margin-top:10px;font-size:12.5px;color:var(--text-mute)">
          今日已学新词 <b>${learnedToday}</b> 个
          ${state.dailyNew ? `· 目标 ${state.dailyNew} 个${learnedToday >= state.dailyNew ? '（已达成 ✓）' : ''}` : ''}
        </div>` : ''}
        ${!more && !isNew ? `<div id="due-again" style="margin-top:10px;font-size:12.5px;color:var(--text-mute)">正在检查还有没有到期的词…</div>` : ''}
        <div class="row" style="justify-content:center;gap:10px;margin-top:18px;flex-wrap:wrap">
          ${more ? `<button class="btn btn-primary" id="p-next">继续下一批（还有 ${state.newAvail} 个新词）</button>` : ''}
          ${more ? '<button class="btn" id="p-stop">今天到这里</button>' : ''}
          ${!more && isNew ? '<button class="btn" id="p-review">去复习</button>' : ''}
          ${!more && !isNew && state.dueTotal > 0 ? '<button class="btn" id="p-extra2">再刷一遍</button>' : ''}
          <button class="btn btn-ghost" id="p-home">返回今日</button>
        </div>
      </div>`;
    state.panel = 'done';

    const next = document.getElementById('p-next');
    if (next) next.addEventListener('click', async () => {
      state.panel = null;
      await loadNextBatch();
      paint();
    });
    const stop = document.getElementById('p-stop');
    if (stop) stop.addEventListener('click', () => window.App.go('#/today'));
    const goReview = document.getElementById('p-review');
    if (goReview) goReview.addEventListener('click', () => window.App.go('#/review'));
    const extra2 = document.getElementById('p-extra2');
    if (extra2) extra2.addEventListener('click', async () => {
      state.panel = null;
      await loadNextBatch(true);   // 复习：忽略今日目标，硬再刷一轮
      paint();
    });
    document.getElementById('p-home').addEventListener('click', () => window.App.go('#/today'));

    /*
     * 复习做完后再查一次「还有没有到期的」。
     * 必须查 —— 因为复习过的词会按记忆间隔排下一次，
     * 阶段 0→1 只要 30 分钟、1→2 是 12 小时，所以一轮做得久的话，
     * 早先复习过的词已经又到期了。不说明白的话，用户看到徽标还有数字
     * 会以为「明明做完了怎么还没清」（这次就是这么报障的）。
     */
    if (!more && !isNew) {
      API.today(state.bookCode)
        .then((t) => {
          const n = (t && t.pools && t.pools.dueTotal) || 0;
          state.dueTotal = n;
          const el = document.getElementById('due-again');
          if (el) {
            el.innerHTML = n
              ? `又有 <b>${n}</b> 个词到期了，可以再刷一遍。`
              : '已确认：现在没有到期的词了';
          }
          const again = document.getElementById('p-extra2');
          if (again) again.style.display = n ? '' : 'none';
        })
        .catch(() => { /* 查不到就不显示 */ });
    }
  }

  /**
   * 作答后的轻量反馈（居中一闪，不打断节奏）。
   *
   * 三档各自的**实际后果**必须说实话 —— 反馈是用户判断「刚才那一下算什么」的唯一依据：
   *   known   → 过关，间隔大步推进（跳 2 档）
   *   vague   → 过关，间隔只推进 1 档
   *   unknown → 不过关，搬到队列后面再考
   *
   * 以前这里只传一个布尔 passed，导致「模糊」和「认识」都显示绿色「✓ 已掌握」，
   * 而同一次点击落库的是打回第 0 档 + 明天复习 + vague_count+1（记账词、参与顽固词判定）。
   * 用户看到的和实际发生的完全相反。
   *
   * 颜色用 CSS 令牌而不是字面量：亮绿配白字在浅色主题下对比度不足，
   * 而 var(--ok) / var(--warn) / var(--bad) 在浅色主题里已经整体压深过一档。
   */
  function showFeedback(w, rating) {
    const STYLE = {
      known: { bg: 'var(--ok)', text: '✓ 记住了 · 下次隔得更久' },
      vague: { bg: 'var(--warn)', text: '～ 有点模糊 · 间隔只进一档' },
      unknown: { bg: 'var(--bad)', text: '✗ 不认识 · 稍后再考' },
    };
    const cfg = STYLE[rating] || STYLE.unknown;

    const toast = document.createElement('div');
    toast.className = 'srs-toast';
    toast.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      padding: 12px 24px;
      border-radius: var(--r-md);
      font-size: 14px;
      font-weight: 500;
      color: #fff;   /* 实心语义色底上的白字（规范允许的例外） */
      background: ${cfg.bg};
      z-index: 1000;
      pointer-events: none;
      animation: fadeInOut 0.5s ease;
    `;
    toast.textContent = cfg.text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 600);
  }
  /** 会话结束时上报学习时长 */
  function reportTime() {
    const sec = Math.round((Date.now() - state.startedAt) / 1000);
    if (sec > 20 && sec < 6 * 3600) {
      API.studyTime(sec).catch(() => { /* 静默 */ });
    }
  }

  window.Views = window.Views || {};
  // 同一个视图挂两个路由。app.js 只把 URL 的 query 当 params 传进来，
  // 不含路由名，所以模式必须在**绑定这一刻**确定，
  // 不能在 render 里读 params.mode —— #/review 根本没有 query。
  window.Views.study = { render: (el, params) => render(el, params, 'new') };
  window.Views.review = { render: (el, params) => render(el, params, 'review') };
})();
