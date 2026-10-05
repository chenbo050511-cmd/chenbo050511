/* 真题 —— 题库浏览 / 短文阅读 / 段落匹配 / 记录 */
(function () {
  'use strict';

  const U = window.UI;
  const KIND = { reading: '短文阅读', matching: '段落匹配' };

  const state = {
    tab: 'bank',        // bank | records | wrong
    filters: { level: '', kind: '', year: '', status: 'all', q: '', page: 1 },
    list: null,
    overview: null,
    years: [],
    doing: null,        // { set, questions, paragraphs, picks, startedAt, timed }
    result: null,
    records: null,
    wrong: null,
  };

  let timer = null;
  let root = null;

  function clearTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ------------------------------------------------------------------ */
  /* 入口                                                                */
  /* ------------------------------------------------------------------ */

  async function render(el, params) {
    root = el;
    clearTimer();
    state.doing = null;
    state.result = null;
    state.tab = params.tab === 'records' || params.tab === 'wrong' ? params.tab : 'bank';
    state.filters.page = 1;
    state.records = null;
    state.wrong = null;

    window.App._cleanup = () => { clearTimer(); closeDrawer(); };

    if (params.set) {
      await openSet(Number(params.set));
      return;
    }
    if (state.tab === 'bank') await loadBank();
    else if (state.tab === 'records') await loadRecords();
    else await loadWrong();
  }

  function frame(inner) {
    root.innerHTML = `<div class="exam-shell">${inner}</div>`;
    return root.querySelector('.exam-shell');
  }

  function tabs(active) {
    return `<div class="seg" id="exam-tabs" style="width:fit-content">
      <button data-t="bank" class="${active === 'bank' ? 'on' : ''}">题库</button>
      <button data-t="records" class="${active === 'records' ? 'on' : ''}">做题记录</button>
      <button data-t="wrong" class="${active === 'wrong' ? 'on' : ''}">题目错题</button>
    </div>`;
  }

  function bindTabs() {
    const box = document.getElementById('exam-tabs');
    if (!box) return;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      window.App.go('#/exam?tab=' + b.dataset.t);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 题库列表                                                            */
  /* ------------------------------------------------------------------ */

  async function loadBank() {
    root.innerHTML = `<div class="exam-shell"><div class="card"><div class="skel" style="height:18px;width:220px"></div></div></div>`;
    const [ov, list] = await Promise.all([
      API.examOverview(),
      API.examSets({ ...state.filters, year: state.filters.year, size: 30 }),
    ]);
    state.overview = ov;
    state.list = list;
    state.years = ov.byYear.map((y) => y.year);
    paintBank();
  }

  function paintBank() {
    const ov = state.overview;
    const list = state.list;
    const f = state.filters;

    frame(`
      <div class="page-head">
        <div>
          <h1>真题题库</h1>
          <div class="sub">四六级历年真题的短文阅读与段落匹配，做完即时批改并定位到原文</div>
        </div>
        ${tabs('bank')}
      </div>

      <div class="exam-stats">
        ${stat('试卷', ov.papers, '套')}
        ${stat('短文阅读', ov.reading_sets, '组')}
        ${stat('段落匹配', ov.matching_sets, '组')}
        ${stat('已做', ov.done_sets, `<small>/ ${ov.sets} 组</small>`)}
        ${stat('累计正确率', ov.accuracy, '<small>%</small>')}
      </div>

      <div class="filter-bar">
        <input class="input" id="ex-q" placeholder="搜索文章标题、试卷编号…" value="${U.esc(f.q)}">
        <select class="select" id="ex-level">
          <option value="">全部级别</option>
          <option value="cet4" ${f.level === 'cet4' ? 'selected' : ''}>CET-4 四级</option>
          <option value="cet6" ${f.level === 'cet6' ? 'selected' : ''}>CET-6 六级</option>
        </select>
        <select class="select" id="ex-kind">
          <option value="">全部题型</option>
          <option value="reading" ${f.kind === 'reading' ? 'selected' : ''}>短文阅读</option>
          <option value="matching" ${f.kind === 'matching' ? 'selected' : ''}>段落匹配</option>
        </select>
        <select class="select" id="ex-year">
          <option value="">全部年份</option>
          ${state.years.map((y) => `<option value="${y}" ${String(f.year) === String(y) ? 'selected' : ''}>${y} 年</option>`).join('')}
        </select>
        <select class="select" id="ex-status">
          ${[['all', '全部状态'], ['todo', '还没做过'], ['done', '做过的'], ['wrong', '有错题']]
            .map(([v, t]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <button class="btn btn-sm" id="ex-reset">重置</button>
      </div>

      ${list.items.length ? `<div class="exam-list" id="exam-list">
        ${list.items.map(card).join('')}
      </div>${pager(list)}` : `<div class="card"><div class="empty">
        <div class="em-ico">${U.icon('search', 'ico')}</div>
        <h3>没有符合条件的题目</h3>
        <p>换个筛选条件试试，或者点「重置」看全部题库。</p>
        <button class="btn" id="ex-reset2">重置筛选</button>
      </div></div>`}
    `);

    bindTabs();
    const on = (id, ev, fn) => { const n = document.getElementById(id); if (n) n.addEventListener(ev, fn); };

    on('ex-q', 'input', U.debounce((e) => { f.q = e.target.value.trim(); f.page = 1; reloadBankKeepFocus(); }, 320));
    on('ex-level', 'change', (e) => { f.level = e.target.value; f.page = 1; loadBank(); });
    on('ex-kind', 'change', (e) => { f.kind = e.target.value; f.page = 1; loadBank(); });
    on('ex-year', 'change', (e) => { f.year = e.target.value; f.page = 1; loadBank(); });
    on('ex-status', 'change', (e) => { f.status = e.target.value; f.page = 1; loadBank(); });
    on('ex-reset', 'click', resetFilters);
    on('ex-reset2', 'click', resetFilters);

    root.querySelectorAll('[data-epage]').forEach((b) => {
      b.addEventListener('click', () => {
        f.page = Number(b.dataset.epage);
        loadBank();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    root.querySelectorAll('[data-open]').forEach((c) => {
      c.addEventListener('click', () => openSet(Number(c.dataset.open)));
    });
  }

  async function reloadBankKeepFocus() {
    await loadBank();
    const inp = document.getElementById('ex-q');
    if (inp && state.filters.q) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  }

  function resetFilters() {
    state.filters = { level: '', kind: '', year: '', status: 'all', q: '', page: 1 };
    loadBank();
  }

  function stat(k, v, suffix) {
    return `<div class="exam-stat"><span class="k">${k}</span><span class="v">${v}${suffix || ''}</span></div>`;
  }

  function card(it) {
    const score = it.best_score;
    const scoreColor = score >= 80 ? 'var(--ok)' : score >= 60 ? 'var(--warn)' : 'var(--bad)';
    return `
      <div class="exam-card" data-open="${it.id}">
        <div class="ec-main">
          <div class="ec-top">
            <span class="chip ${it.level === 'cet6' ? 'reviewing' : 'new'}">${it.level === 'cet6' ? 'CET-6' : 'CET-4'}</span>
            <span class="chip">${KIND[it.kind]}</span>
            ${it.has_wrong ? `<span class="chip due">有错题</span>` : ''}
          </div>
          <div class="ec-title">${U.esc(it.title || KIND[it.kind])}</div>
          <div class="ec-paper">${U.esc(it.paper_title)}</div>
        </div>
        <div class="ec-side">
          <span class="ec-num">${it.question_count} ${it.kind === 'matching' ? '条陈述' : '题'} · ${it.word_count} 词</span>
          ${it.attempts
            ? `<span class="ec-score" style="color:${scoreColor}">${score}<small style="font-size:12px;font-weight:500;color:var(--text-mute)">%</small></span>
               <span class="ec-num">做过 ${it.attempts} 次</span>`
            : `<span class="btn btn-sm">开始做题</span>`}
        </div>
      </div>`;
  }

  function pager(list) {
    if (list.pages <= 1) return `<div class="pager">共 ${list.total} 组题目</div>`;
    const cur = list.page;
    const pages = [];
    for (let i = 1; i <= list.pages; i++) {
      if (i === 1 || i === list.pages || Math.abs(i - cur) <= 2) pages.push(i);
      else if (pages[pages.length - 1] !== '…') pages.push('…');
    }
    return `<div class="pager">
      <button class="btn btn-sm" data-epage="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>上一页</button>
      ${pages.map((p) => p === '…' ? '<span>…</span>'
        : `<button class="btn btn-sm ${p === cur ? 'btn-primary' : ''}" data-epage="${p}">${p}</button>`).join('')}
      <button class="btn btn-sm" data-epage="${cur + 1}" ${cur >= list.pages ? 'disabled' : ''}>下一页</button>
      <span style="margin-left:8px">共 ${list.total} 组</span>
    </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* 做题                                                                */
  /* ------------------------------------------------------------------ */

  async function openSet(id) {
    clearTimer();
    root.innerHTML = `<div class="exam-shell"><div class="card"><div class="skel" style="height:18px;width:200px"></div></div></div>`;
    const data = await API.examSet(id);
    hlLoad(id);
    state.doing = {
      set: data.set,
      questions: data.questions,
      paragraphs: data.paragraphs,
      readingParagraphs: data.readingParagraphs || [],
      picks: {},
      startedAt: Date.now(),
      elapsed: 0,
      kindText: data.kindText,
      lastAttempt: data.lastAttempt,
    };
    state.result = null;
    paintDoing();
  }

  /* ---------------------------------------------------------------- */
  /* 划词标记：点短文里的单词，弹出色板给它加一条下划线                    */
  /* ---------------------------------------------------------------- */

  const HL_COLORS = [
    { name: '黄', c: '#f59e0b' },
    { name: '绿', c: '#10b981' },
    { name: '蓝', c: '#3b82f6' },
    { name: '红', c: '#ef4444' },
    { name: '紫', c: '#a855f7' },
  ];

  /**
   * 把一段文本按单词切开，包成可点击的 span。
   * prefix 用来生成稳定的位置键（同一篇短文每次渲染都一样），例如 `r0:12`、`mA:5`。
   * 切分规则：只认英文单词（真题都是英文）。
   */
  function hlHtml(text, prefix) {
    const src = String(text);
    let out = '';
    let idx = 0;
    for (const m of src.matchAll(/[A-Za-z][A-Za-z'\u2019-]*/g)) {
      out += U.esc(src.slice(idx, m.index));
      const key = `${prefix}:${m.index}`;
      const color = state.hl ? state.hl[key] : undefined;
      out += `<span class="hl-w${color != null ? ' on' : ''}" data-key="${U.esc(key)}"` +
        `${color != null ? ` data-c="${color}"` : ''}>${U.esc(m[0])}</span>`;
      idx = m.index + m[0].length;
    }
    out += U.esc(src.slice(idx));
    return out;
  }

  function hlLoad(setId) {
    try { state.hl = JSON.parse(localStorage.getItem('wm:hl:' + setId) || '{}') || {}; }
    catch (err) { state.hl = {}; }
    if (typeof state.hl !== 'object' || Array.isArray(state.hl)) state.hl = {};
  }

  function hlSave() {
    if (!state.doing) return;
    try { localStorage.setItem('wm:hl:' + state.doing.set.id, JSON.stringify(state.hl)); } catch (err) { /* 存不下就算了 */ }
  }

  function hlApply(span, color) {
    const key = span.dataset.key;
    if (key == null) return;
    if (color == null) {
      delete state.hl[key];
      span.classList.remove('on');
      span.removeAttribute('data-c');
    } else {
      state.hl[key] = color;
      span.classList.add('on');
      span.dataset.c = color;
    }
    hlSave();
    hlSyncButtons();
  }

  function hlClose() {
    const pop = document.querySelector('.hl-pop');
    if (pop) pop.remove();
  }

  /**
   * 「清除划线」按钮。
   * 注意：**要一直渲染出来**，靠 JS 控制显隐和条数 ——
   * 因为它是渲染时生成的，而用户是在渲染之后才划的词，
   * 如果只在「有划线时」才输出 HTML，标完第一个词按钮也不会出现（踩过）。
   */
  function hlClearBtn() {
    const n = Object.keys(state.hl || {}).length;
    return `<button class="hl-clear"${n ? '' : ' hidden'} title="清除这一套卷里的全部划线">清除划线 <b>${n}</b></button>`;
  }

  /** 每次划线增删后同步按钮的显隐与条数 */
  function hlSyncButtons() {
    const n = Object.keys(state.hl || {}).length;
    document.querySelectorAll('.hl-clear').forEach((b) => {
      const badge = b.querySelector('b');
      if (badge) badge.textContent = n;
      if (n) b.removeAttribute('hidden');
      else b.setAttribute('hidden', '');
    });
  }

  /**
   * 一键清除：清掉**当前套卷**的全部划线（原文 + 题干 + 选项一起）。
   * 不清空整个 localStorage —— 别的套卷的划线不受影响。
   */
  function hlClearAll() {
    const n = Object.keys(state.hl || {}).length;
    if (!n) return 0;
    if (!window.confirm(`清除这一套卷的全部划线？共 ${n} 处，清掉后无法恢复。`)) return -1;
    state.hl = {};
    hlSave();
    document.querySelectorAll('.hl-w.on').forEach((el) => {
      el.classList.remove('on');
      el.removeAttribute('data-c');
    });
    hlSyncButtons();
    hlClose();
    return n;
  }

  /** 在被点的单词下方弹出色板 */
  /**
   * 点词弹层：查词义 + 加入错题本 + 划线。
   *
   * 释义默认**收起**，点「显示中文释义」才展开 —— 做真题时先自己回想，
   * 想看再看，不被动剧透。
   */
  function hlOpen(span) {
    const box = span.closest('.passage-box, .qbox');
    if (!box) return;
    hlClose();

    const token = String(span.textContent || '').trim();
    const accent = window.App.state.settings.accent;

    const pop = document.createElement('div');
    pop.className = 'hl-pop wide';
    pop.innerHTML = `
      <div class="wp-head">
        <span class="wp-word" id="wp-word">${U.esc(token)}</span>
        <span class="wp-phon" id="wp-phon"></span>
        <button class="wp-icon" id="wp-speak" title="朗读">${U.icon('speaker')}</button>
      </div>
      <div class="wp-body" id="wp-body">查询中…</div>
      <div class="wp-foot">
        <button class="wp-btn" id="wp-mean">显示中文释义</button>
        <button class="wp-btn" id="wp-mark" disabled>加入错题本</button>
      </div>
      <div class="wp-colors">
        ${HL_COLORS.map((c, i) => `<button class="sw" data-c="${i}" style="background:${c.c}" title="${c.name}"></button>`).join('')}
        <button class="rm" title="清除这条下划线">✕</button>
      </div>
    `;
    box.appendChild(pop);

    /*
     * 定位。抽成函数是因为弹层高度会变（展开释义、查词回来），
     * 每次变化都要重新量、重新摆，否则会溢出框外。
     *
     * 关键：弹层是 position:absolute 挂在原文框里的，而原文框有
     * max-height + overflow:auto，会**内部滚动**。
     * absolute 的 left/top 是「内容坐标」，getBoundingClientRect 给的是视口坐标，
     * 两者差一个 scrollTop/scrollLeft —— 不补上，框内一滚动弹层就按滚动量偏出去。
     */
    function place() {
      const popW = pop.offsetWidth || 260;
      const popH = pop.offsetHeight || 120;
      const br = span.getBoundingClientRect();
      const bx = box.getBoundingClientRect();
      const st = box.scrollTop;
      const sl = box.scrollLeft;

      let left = br.left - bx.left + sl + br.width / 2 - popW / 2;
      left = Math.max(6, Math.min(left, box.clientWidth - popW - 6));

      let top;
      const roomBelow = bx.bottom - br.bottom;
      if (roomBelow >= popH + 12) {
        top = br.bottom - bx.top + st + 7;
      } else {
        const above = br.top - bx.top + st - popH - 7;
        top = above >= st + 4 ? above : br.bottom - bx.top + st + 7;
      }
      pop.style.left = `${left}px`;
      pop.style.top = `${Math.max(st + 4, top)}px`;
    }
    place();

    const bodyEl = pop.querySelector('#wp-body');
    const phonEl = pop.querySelector('#wp-phon');
    const meanBtn = pop.querySelector('#wp-mean');
    const markBtn = pop.querySelector('#wp-mark');

    let info = null;
    let showMeaning = false;

    function renderBody() {
      if (!info) return;
      if (!info.found) {
        phonEl.textContent = '';
        bodyEl.innerHTML = '<span class="wp-empty">词典里没有这个词，可以先划线标个记号。</span>';
        meanBtn.style.display = 'none';
        markBtn.style.display = 'none';
        return;
      }
      const w = info.word;
      phonEl.textContent = w.phonetic ? `/${w.phonetic}/` : '';
      const blocks = [];
      if (showMeaning) {
        blocks.push(`<div class="wp-sec"><span class="wp-lbl">释义</span>
          <div>${U.esc(w.meaning || '')}${w.meaning_alt ? `<div class="wp-alt">专业：${U.esc(w.meaning_alt)}</div>` : ''}</div></div>`);
        if (w.exchange) {
          blocks.push(`<div class="wp-sec"><span class="wp-lbl">词形</span><div class="wp-alt">${U.esc(w.exchange)}</div></div>`);
        }
      } else {
        blocks.push('<span class="wp-empty">释义收着 —— 先自己回想一下，想看再点下面的按钮。</span>');
      }
      if (info.phrases && info.phrases.length) {
        blocks.push(`<div class="wp-sec"><span class="wp-lbl">真题搭配</span>
          <div class="wp-ph">${info.phrases.map((p) => `<span>${U.esc(p)}</span>`).join('')}</div></div>`);
      }
      if (info.source === 'extra') {
        blocks.push('<div class="wp-alt" style="margin-top:9px">不在四级词表内，只能查义、不能加入错题本。</div>');
      }
      bodyEl.innerHTML = blocks.join('');
      meanBtn.textContent = showMeaning ? '收起释义' : '显示中文释义';
    }

    // 划线：点色块加下划线，点 ✕ 清除
    pop.addEventListener('click', (e) => {
      e.stopPropagation();
      const sw = e.target.closest('.sw');
      if (sw) { hlApply(span, Number(sw.dataset.c)); hlClose(); return; }
      if (e.target.closest('.rm')) { hlApply(span, null); hlClose(); }
    });

    pop.querySelector('#wp-speak').addEventListener('click', (e) => {
      e.stopPropagation();
      U.speak(token, accent);
    });

    meanBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showMeaning = !showMeaning;
      renderBody();
      place();
    });

    markBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!info || !info.found) return;
      try {
        const d = await API.markWord(info.word.id);
        info.marked = d.marked;
        markBtn.textContent = d.marked ? '已加入错题本 ✓' : '加入错题本';
        markBtn.classList.toggle('on', !!d.marked);
        U.toast(d.marked ? `「${info.word.spelling}」已加入错题本` : `「${info.word.spelling}」已移出错题本`, d.marked ? 'ok' : '');
        window.App.refreshBadges();
      } catch (err) {
        U.toast(err.message, 'bad');
      }
    });

    API.lookupWord(token)
      .then((d) => {
        info = d;
        if (d.found && d.marked) {
          markBtn.textContent = '已加入错题本 ✓';
          markBtn.classList.add('on');
        }
        // 只有词库里的词能加入错题本（错题本是「词库里的难词清单」）
        const canMark = d.found && !!d.word.id;
        markBtn.disabled = !canMark;
        if (d.found && !canMark) markBtn.title = '不在四级词表内，无法加入错题本';
        renderBody();
        place();
      })
      .catch(() => {
        info = { found: false };
        meanBtn.style.display = 'none';
        bodyEl.innerHTML = '<span class="wp-empty">查询失败，可以先划线标个记号。</span>';
        place();
      });

    pop.dataset.key = span.dataset.key;
    pop._target = span;
  }

  /** 点短文里的单词 → 弹色板；点别处 → 收起 */
  function bindHl(box) {
    if (!box) return;
    box.addEventListener('click', (e) => {
      const clr = e.target.closest('.hl-clear');
      if (clr) {
        e.stopPropagation();
        hlClearAll();
        return;
      }
      const word = e.target.closest('.hl-w');
      if (word) {
        e.stopPropagation();
        // 再点同一个词：如果色板已经为它开着就收起
        const open = document.querySelector('.hl-pop');
        if (open && open.dataset.key === word.dataset.key) { hlClose(); return; }
        hlOpen(word);
        return;
      }
      if (!e.target.closest('.hl-pop')) hlClose();
    });
  }

  let hlOutsideBound = false;
  function bindHlOutside() {
    if (hlOutsideBound) return;
    hlOutsideBound = true;
    document.addEventListener('click', () => hlClose());
  }

  /**
   * 渲染阅读短文正文。
   * 优先用从真题 PDF 还原出来的分段；取不到分段时退回整段（源题库本来就是整块）。
   */
  function passageHtml(d) {
    const paras = d.readingParagraphs || [];
    if (paras.length) {
      return `<div class="passage-text">${paras.map((p, i) => `<p>${hlHtml(p, `r${i}`)}</p>`).join('')}</div>`;
    }
    return `<div class="passage-text"><p>${hlHtml(d.set.passage, 'r')}</p></div>`;
  }

  function paintDoing() {
    const d = state.doing;
    const isMatch = d.set.kind === 'matching';
    const letters = d.paragraphs.map((p) => p.label);
    const answered = Object.values(d.picks).filter(Boolean).length;
    const total = d.questions.length;

    const passage = isMatch
      ? `<div class="pb-head">
           <span class="chip">${KIND[d.set.kind]}</span>
           <span class="chip">${letters.length} 个段落</span>
           <span class="chip">点词可划线</span>
           ${hlClearBtn()}
         </div>
         ${d.set.title ? `<div class="pb-title">${U.esc(d.set.title)}</div>` : ''}
         <div class="pb-inst">${U.esc(d.set.instructions)}</div>
         <div id="para-list">
           ${d.paragraphs.map((p) => `
             <div class="para-item" data-para="${p.label}">
               <span class="pl">${p.label}</span>
               <span class="pt">${hlHtml(p.text, `m${p.label}`)}</span>
             </div>`).join('')}
         </div>`
      : `<div class="pb-head">
           <span class="chip">${KIND[d.set.kind]}</span>
           <span class="chip">${d.set.word_count} 词</span>
           ${d.readingParagraphs.length ? `<span class="chip">${d.readingParagraphs.length} 段</span>` : ''}
           <span class="chip">点词可划线</span>
           <span class="chip">${total} 题</span>
           ${hlClearBtn()}
         </div>
         <div class="pb-inst">${U.esc(d.set.instructions)}</div>
         ${passageHtml(d)}`;

    // 移动端：顶部题目导航指示器
    const qnav = `<div class="exam-qnav" id="exam-qnav">
      <button class="qnav-btn" id="qnav-prev" disabled>‹</button>
      <span class="qnav-counter" id="qnav-counter">1 / ${total}</span>
      <button class="qnav-btn" id="qnav-next">›</button>
    </div>`;

    frame(`
      <div class="exam-top">
        <button class="btn btn-sm btn-ghost" id="ex-back">${U.icon('arrowLeft')} 返回题库</button>
        <div class="et-info">
          <b>${U.esc(d.set.paper_title)}</b>
          <span>${KIND[d.set.kind]}${d.set.title ? ' · ' + U.esc(d.set.title) : ''}${d.lastAttempt ? ` · 上次 ${d.lastAttempt.right_count}/${d.lastAttempt.total}` : ''}</span>
        </div>
        <span class="spacer"></span>
        <span class="exam-timer" id="ex-timer">00:00</span>
        <button class="btn btn-primary" id="ex-submit">${U.icon('check')} 交卷批改</button>
      </div>

      <div class="exam-split">
        <div class="passage-box" id="passage-box">
          <div class="passage-scroll" id="passage-scroll">${passage}</div>
          <button class="passage-collapse-btn" id="passage-toggle">收起原文 ▲</button>
        </div>
        <div class="qbox" id="qbox">
          ${qnav}
          <div class="qbox-scroll" id="qbox-scroll">
            ${d.questions.map((q, i) => questionBlock(q, i, isMatch, letters)).join('')}
          </div>
        </div>
      </div>

      <div class="exam-answer-panel">
        <span class="exam-timer exam-timer-mobile" id="ex-timer-mobile">00:00</span>
        <div class="exam-progress-mini" id="ex-dots">
          ${d.questions.map((q) => `<i data-dot="${q.id}"></i>`).join('')}
        </div>
        <span style="font-size:12.5px;color:var(--text-dim)" id="ex-count">已作答 ${answered} / ${total}</span>
        <span class="spacer"></span>
        <button class="btn btn-primary btn-sm" id="ex-submit2">交卷批改</button>
      </div>
    `);

    document.getElementById('ex-back').addEventListener('click', () => window.App.go('#/exam'));
    document.getElementById('ex-submit').addEventListener('click', submit);
    document.getElementById('ex-submit2').addEventListener('click', submit);

    const box = document.getElementById('qbox-scroll');
    const qboxEl = document.getElementById('qbox');

    // ---- 选项/段落点击 ----
    box.addEventListener('click', (e) => {
      if (state.result) return;
      const opt = e.target.closest('.qq-opt');
      if (opt) {
        d.picks[Number(opt.dataset.q)] = opt.dataset.label;
        refreshPicks();
        return;
      }
      const pick = e.target.closest('.pick-btn');
      if (pick) {
        d.picks[Number(pick.dataset.q)] = pick.dataset.label;
        refreshPicks();
      }
    });

    // ---- 移动端左右滑动切换题目 ----
    let touchStartX = 0, touchStartY = 0, touchStartScroll = 0, touchMoved = false;
    box.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartScroll = box.scrollLeft;
      touchMoved = false;
    }, { passive: true });
    box.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dx > 10 && dx > dy) touchMoved = true;
    }, { passive: true });
    box.addEventListener('touchend', (e) => {
      if (!touchMoved) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
      if (Math.abs(dx) > 40 && Math.abs(dx) > dy * 1.2) {
        const w = box.clientWidth;
        if (dx < 0) goToQuestion(Math.round((box.scrollLeft + w) / w));
        else goToQuestion(Math.round((box.scrollLeft - w) / w));
      }
    }, { passive: true });

    function getCurrentQIdx() {
      return Math.round(box.scrollLeft / box.clientWidth);
    }
    function goToQuestion(idx) {
      idx = Math.max(0, Math.min(total - 1, idx));
      box.scrollTo({ left: idx * box.clientWidth, behavior: 'smooth' });
    }
    function goNextQuestion() { goToQuestion(getCurrentQIdx() + 1); }
    function goPrevQuestion() { goToQuestion(getCurrentQIdx() - 1); }

    // 监听滚动更新计数器
    box.addEventListener('scroll', () => {
      const idx = getCurrentQIdx();
      const counter = document.getElementById('qnav-counter');
      if (counter) counter.textContent = `${idx + 1} / ${total}`;
    }, { passive: true });

    // 导航按钮
    document.getElementById('qnav-prev')?.addEventListener('click', goPrevQuestion);
    document.getElementById('qnav-next')?.addEventListener('click', goNextQuestion);

    // 划词：原文和题干都能点
    bindHl(document.getElementById('passage-scroll'));
    bindHl(document.querySelector('.qbox'));
    bindHlOutside();

    // 文章收起/展开
    const toggleBtn = document.getElementById('passage-toggle');
    const pscroll = document.getElementById('passage-scroll');
    if (toggleBtn && pscroll) {
      toggleBtn.addEventListener('click', function() {
        pscroll.classList.toggle('collapsed');
        toggleBtn.textContent = pscroll.classList.contains('collapsed') ? '展开原文 ▼' : '收起原文 ▲';
      });
    }

    const paraList = document.getElementById('para-list');
    if (paraList) {
      paraList.addEventListener('click', (e) => {
        const item = e.target.closest('.para-item');
        if (!item) return;
        const label = item.dataset.para;
        document.querySelectorAll('#para-list .para-item').forEach((n) => n.classList.toggle('on', n === item));
        document.querySelectorAll('.pick-btn').forEach((b) => {
          b.classList.toggle('answer', b.dataset.label === label && b.classList.contains('sel'));
        });
        document.querySelectorAll('.pick-btn.sel').forEach((b) => {
          const hit = b.dataset.label === label;
          b.closest('.qq').style.outline = hit ? '1px solid var(--accent-line)' : '';
        });
      });
    }

    // 默认滚动到第一题
    box.scrollTo({ left: 0, behavior: 'instant' });

    refreshPicks();
    startTimer();
  }
function questionBlock(q, i, isMatch, letters) {
    const opts = isMatch
      ? `<div class="pick-strip">
           ${letters.map((L) => `<button class="pick-btn" data-q="${q.id}" data-label="${L}">${L}</button>`).join('')}
         </div>`
      : `<div class="qq-opts">
           ${q.options.map((o) => `
             <button class="qq-opt" data-q="${q.id}" data-label="${o.label}">
               <span class="ol">${o.label}</span><span>${U.esc(o.text)}</span>
             </button>`).join('')}
         </div>`;
    const answered = state.doing.picks[q.id] ? ' answered' : '';
    return `<div class="qq${answered}" id="q-${q.id}" data-idx="${i}" data-answer="${state.doing.picks[q.id] || ''}">
      <div class="qq-stem"><span class="qn">${q.q_number || i + 1}</span><span class="qq-stem-text">${hlHtml(q.stem, `q${q.id}`)}</span><span class="qq-chevron">${state.doing.picks[q.id] ? '✓' : '▼'}</span></div>
      <div class="qq-body">
        ${opts}
        <div class="qq-feedback" id="fb-${q.id}" style="display:none"></div>
      </div>
    </div>`;
  }


  function refreshPicks() {
    const d = state.doing;
    if (!d) return;
    let n = 0;
    for (const q of d.questions) {
      const picked = d.picks[q.id];
      if (picked) n++;
      document.querySelectorAll(`[data-q="${q.id}"]`).forEach((b) => {
        b.classList.toggle('sel', b.dataset.label === picked);
      });
      const dot = document.querySelector(`[data-dot="${q.id}"]`);
      if (dot) dot.classList.toggle('done', !!picked);
      // 同步折叠卡片状态
      const qq = document.getElementById(`q-${q.id}`);
      if (qq) {
        qq.classList.toggle('answered', !!picked);
        qq.dataset.answer = picked || '';
        const chevron = qq.querySelector('.qq-chevron');
        if (chevron) chevron.textContent = picked ? '\u2713' : '\u25BC';
      }
    }
    const c = document.getElementById('ex-count');
    if (c) c.textContent = `已作答 ${n} / ${d.questions.length}`;
  }


  function startTimer() {
    clearTimer();
    const tick = () => {
      const d = state.doing;
      if (!d || state.result) return;
      d.elapsed = Date.now() - d.startedAt;
      const el = document.getElementById('ex-timer');
      if (el) el.textContent = fmtDuration(d.elapsed);
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  async function submit() {
    const d = state.doing;
    if (!d) return;
    const answers = d.questions
      .filter((q) => d.picks[q.id])
      .map((q) => ({ questionId: q.id, chosen: d.picks[q.id] }));

    if (!answers.length) return U.toast('还没有作答，先选几个答案吧', 'bad');
    if (answers.length < d.questions.length &&
        !window.confirm(`还有 ${d.questions.length - answers.length} 题没作答，未作答按错误计分。确定交卷吗？`)) return;

    try {
      clearTimer();
      const res = await API.examSubmit(d.set.id, answers, d.elapsed);
      state.result = res;
      paintResult();
      U.toast(`批改完成：${res.right}/${res.total}（${res.accuracy}%）`, res.accuracy >= 60 ? 'ok' : '');
    } catch (err) {
      U.toast(err.message, 'bad');
      startTimer();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 批改结果                                                            */
  /* ------------------------------------------------------------------ */

  function paintResult() {
    const d = state.doing;
    const r = state.result;
    const isMatch = d.set.kind === 'matching';
    const byId = new Map(d.questions.map((q) => [q.id, q]));
    const verdict = r.accuracy >= 90 ? '很稳，这套可以过了' : r.accuracy >= 70 ? '基本掌握，错题再过一遍'
      : r.accuracy >= 50 ? '有明显漏洞，建议精读原文' : '这套偏难，先把错题定位到原文看明白';

    // 把答题区换成批改态
    frame(`
      <div class="exam-top">
        <button class="btn btn-sm btn-ghost" id="ex-back2">${U.icon('arrowLeft')} 返回题库</button>
        <div class="et-info">
          <b>${U.esc(d.set.paper_title)}</b>
          <span>${KIND[d.set.kind]}${d.set.title ? ' · ' + U.esc(d.set.title) : ''}</span>
        </div>
        <span class="spacer"></span>
        <span class="exam-timer">用时 ${fmtDuration(r.durationMs)}</span>
      </div>

      <div class="card pad-lg quiz-result">
        <div class="q-tag" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-mute);font-weight:650">本轮得分</div>
        <div class="score-big">${r.right}<span style="font-size:26px;color:var(--text-mute);font-weight:600"> / ${r.total}</span></div>
        <p style="color:var(--text-dim);font-size:13.5px;margin-top:4px">正确率 ${r.accuracy}% · ${verdict}</p>
        <div class="grid g-3" style="margin:22px 0;gap:12px">
          <div class="tile" style="align-items:center"><span class="k">答对</span><span class="v" style="color:var(--ok)">${r.right}</span></div>
          <div class="tile" style="align-items:center"><span class="k">答错</span><span class="v" style="color:var(--bad)">${r.wrong}</span>
            <span style="font-size:11.5px;color:var(--text-mute)">${r.blank ? `其中未作答 ${r.blank}` : '全部作答'}</span></div>
          <div class="tile" style="align-items:center"><span class="k">用时</span><span class="v">${fmtDuration(r.durationMs)}</span></div>
        </div>
        <div class="row" style="justify-content:center;flex-wrap:wrap;gap:10px">
          <button class="btn btn-primary" id="ex-again">${U.icon('refresh')} 再做一遍</button>
          <button class="btn" id="ex-next">${U.icon('arrowRight')} 下一组</button>
          <button class="btn" id="ex-records">${U.icon('list')} 做题记录</button>
        </div>
      </div>

      <div class="exam-split">
        <div class="passage-box">
          <div class="pb-head"><span class="chip">原文</span><span class="chip">${isMatch ? '点段落字母可高亮' : `${d.set.word_count} 词`}</span><span class="chip">点词可划线</span>${hlClearBtn()}</div>
          ${isMatch && d.set.title ? `<div class="pb-title">${U.esc(d.set.title)}</div>` : ''}
          ${isMatch
            ? `<div id="para-list">${d.paragraphs.map((p) => `
                <div class="para-item" data-para="${p.label}">
                  <span class="pl">${p.label}</span><span class="pt">${hlHtml(p.text, `m${p.label}`)}</span>
                </div>`).join('')}</div>`
            : passageHtml(d)}
        </div>
        <div class="qbox">
          ${r.detail.map((item) => {
            const q = byId.get(item.questionId);
            if (!q) return '';
            return questionResult(q, item, isMatch);
          }).join('')}
        </div>
      </div>
    `);

    document.getElementById('ex-back2').addEventListener('click', () => window.App.go('#/exam'));
    document.getElementById('ex-again').addEventListener('click', () => openSet(d.set.id));
    document.getElementById('ex-next').addEventListener('click', goNext);
    document.getElementById('ex-records').addEventListener('click', () => window.App.go('#/exam?tab=records'));
    bindExplanationToggles(document.querySelector('.exam-split .qbox'));

    // 划词标记（结果页里原文、题干、选项都能点）
    bindHl(document.querySelector('.passage-box'));
    bindHl(document.querySelector('.qbox'));

    bindHlOutside();

    // 段落高亮
    const paraList = document.getElementById('para-list');
    if (paraList) {
      paraList.addEventListener('click', (e) => {
        const item = e.target.closest('.para-item');
        if (!item) return;
        const label = item.dataset.para;
        document.querySelectorAll('#para-list .para-item').forEach((n) => n.classList.toggle('on', n === item));
        document.querySelectorAll('.pick-btn').forEach((b) => {
          b.classList.toggle('answer', b.dataset.label === label && b.classList.contains('right'));
        });
        document.querySelectorAll('.pick-btn.sel, .pick-btn.wrong').forEach((b) => {
          if (b.dataset.label === label) b.closest('.qq').classList.add('wrong');
        });
      });
    }
    window.App.refreshBadges();
  }

  function questionResult(q, item, isMatch) {
    let body;
    if (isMatch) {
      const letters = state.doing.paragraphs.map((p) => p.label);
      body = `<div class="pick-strip">
        ${letters.map((L) => {
          const cls = L === item.answer ? 'right' : (L === item.chosen && !item.correct ? 'wrong' : '');
          return `<button class="pick-btn ${cls}" disabled data-q="${q.id}" data-label="${L}">${L}</button>`;
        }).join('')}
      </div>`;
    } else {
      // 结果页的选项是「只读回顾」，所以这里也能划词（答题页不行：点选项是选答案）
      body = `<div class="qq-opts">
        ${q.options.map((o) => {
          const cls = o.label === item.answer ? 'right' : (o.label === item.chosen ? 'wrong' : '');
          return `<button class="qq-opt ${cls}" aria-disabled="true" data-q="${q.id}" data-label="${o.label}">
            <span class="ol">${o.label}</span><span>${hlHtml(o.text, `o${q.id}${o.label}`)}</span></button>`;
        }).join('')}
      </div>`;
    }

    const fb = item.correct
      ? `<span class="ok">答对了</span>`
      : `<span class="no">答错</span> · 你选 ${item.chosen || '未作答'}，正确 <b>${item.answer}</b>`;

    // 匹配题：正确答案所在段落（这就是最直接的「定位」）
    const locate = isMatch && item.answerText
      ? `<div class="exp-row">
           <span class="exp-tag">定位</span>
           <span>答案在 <b>${U.esc(item.answer)}</b> 段：${U.esc(item.answerText)}…</span>
         </div>`
      : '';

    const hasExp = !!(item.explanation || locate);
    // 答错 → 解析直接展开；答对 → 收起来，想看再点
    const expBlock = hasExp
      ? `<div class="qq-exp" id="exp-${q.id}"${item.correct ? ' hidden' : ''}>
           ${locate}
           ${item.explanation
             ? `<div class="exp-row"><span class="exp-tag">解析</span><span>${U.esc(item.explanation)}</span></div>`
             : ''}
         </div>`
      : '';
    const toggle = hasExp && item.correct
      ? `<button class="exp-toggle" data-exp="${q.id}">${U.icon('chevronRight')}<span>查看解析</span></button>`
      : '';

    return `<div class="qq ${item.correct ? 'right' : 'wrong'}" id="q-${q.id}">
      <div class="qq-stem"><span class="qn">${q.q_number || ''}</span><span>${hlHtml(q.stem, `q${q.id}`)}</span></div>
      ${body}
      <div class="qq-feedback">${fb}</div>
      ${toggle}
      ${expBlock}
    </div>`;
  }

  /** 绑定「查看解析 / 收起解析」 */
  function bindExplanationToggles(box) {
    if (!box) return;
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.exp-toggle');
      if (!btn) return;
      const panel = document.getElementById('exp-' + btn.dataset.exp);
      if (!panel) return;
      const show = panel.hasAttribute('hidden');
      if (show) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
      btn.classList.toggle('open', show);
      const label = btn.querySelector('span');
      if (label) label.textContent = show ? '收起解析' : '查看解析';
    });
  }

  async function goNext() {
    try {
      const list = state.list || await API.examSets({ ...state.filters, size: 40 });
      const items = list.items || [];
      const idx = items.findIndex((x) => x.id === state.doing.set.id);
      const next = idx >= 0 ? items[idx + 1] : null;
      if (next) openSet(next.id);
      else window.App.go('#/exam');
    } catch {
      window.App.go('#/exam');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 做题记录                                                            */
  /* ------------------------------------------------------------------ */

  async function loadRecords() {
    root.innerHTML = `<div class="exam-shell"><div class="card"><div class="skel" style="height:18px;width:200px"></div></div></div>`;
    state.records = await API.examRecords(1);
    paintRecords();
  }

  function paintRecords() {
    const r = state.records;
    frame(`
      <div class="page-head">
        <div>
          <h1>做题记录</h1>
          <div class="sub">每套真题做过几次、正确率变化都记在这里</div>
        </div>
        ${tabs('records')}
      </div>

      <div class="exam-stats">
        ${stat('做题次数', r.stats.attempts, '次')}
        ${stat('累计正确率', r.stats.accuracy, '<small>%</small>')}
        ${stat('累计做题', r.stats.answered, '道')}
        ${stat('累计用时', r.stats.minutes, '<small>分钟</small>')}
        ${r.byKind.map((k) => `<div class="exam-stat"><span class="k">${U.esc(k.text)}正确率</span>
          <span class="v">${k.accuracy}<small>% · ${k.attempts} 次</small></span></div>`).join('')}
      </div>

      ${r.items.length ? `
        <div class="card" style="padding:0;overflow:hidden">
          <div style="padding:13px 16px;border-bottom:1px solid var(--border)" class="row">
            <b style="font-size:14px">最近 ${r.items.length} 次</b>
            <span class="spacer"></span>
            <button class="btn btn-sm btn-bad" id="ex-clear">${U.icon('trash')} 清空记录</button>
          </div>
          ${r.items.map(recordRow).join('')}
        </div>` : `<div class="card"><div class="empty">
          <div class="em-ico">${U.icon('list', 'ico')}</div>
          <h3>还没有做题记录</h3>
          <p>去题库挑一组真题做做看，做完会自动记在这里。</p>
          <button class="btn btn-primary" id="ex-tobank">去题库</button>
        </div></div>`}
    `);

    bindTabs();
    const tb = document.getElementById('ex-tobank');
    if (tb) tb.addEventListener('click', () => window.App.go('#/exam'));
    const cl = document.getElementById('ex-clear');
    if (cl) cl.addEventListener('click', async () => {
      if (!window.confirm('确定清空全部做题记录吗？题目和原文不会受影响，只是统计归零。')) return;
      await API.examReset();
      U.toast('已清空做题记录', 'ok');
      loadRecords();
    });

    root.querySelectorAll('[data-attempt]').forEach((row) => {
      row.addEventListener('click', () => showAttempt(Number(row.dataset.attempt)));
    });
  }

  function recordRow(a) {
    const k = KIND[a.kind];
    const acc = Math.round((a.right_count / a.total) * 100);
    const color = acc >= 80 ? 'var(--ok)' : acc >= 60 ? 'var(--warn)' : 'var(--bad)';
    return `<div class="record-row" data-attempt="${a.id}">
      <div style="flex:1;min-width:0">
        <div class="ec-top" style="margin-bottom:3px">
          <span class="chip ${a.level === 'cet6' ? 'reviewing' : 'new'}">${a.level === 'cet6' ? 'CET-6' : 'CET-4'}</span>
          <span class="chip">${k}</span>
          <span style="font-size:11.5px;color:var(--text-mute)">${U.esc(U.relTime(a.created_at))}</span>
        </div>
        <div style="font-size:13.5px;font-weight:600">${U.esc(a.title || k)}</div>
        <div style="font-size:11.5px;color:var(--text-mute)">${U.esc(a.paper_title)}</div>
      </div>
      <div style="text-align:right;flex:none">
        <div style="font-size:18px;font-weight:700;color:${color};font-variant-numeric:tabular-nums">${acc}%</div>
        <div style="font-size:11.5px;color:var(--text-mute)">${a.right_count}/${a.total} · ${fmtDuration(a.duration_ms)}</div>
      </div>
    </div>`;
  }

  async function showAttempt(id) {
    let data;
    try { data = await API.examRecord(id); } catch (err) { return U.toast(err.message, 'bad'); }
    closeDrawer();

    const isMatch = data.attempt.kind === 'matching';
    const mask = document.createElement('div');
    mask.className = 'drawer-mask';
    mask.addEventListener('click', closeDrawer);

    const panel = document.createElement('aside');
    panel.className = 'drawer';
    panel.id = 'attempt-drawer';
    panel.innerHTML = `
      <button class="btn btn-icon btn-ghost d-close">${U.icon('x')}</button>
      <div>
        <div class="row" style="gap:8px;margin-bottom:4px">
          <span class="chip">${KIND[data.attempt.kind]}</span>
          <span class="chip">${U.esc(data.attempt.code)}</span>
        </div>
        <h2 style="font-size:19px;letter-spacing:-.02em">${U.esc(data.attempt.title || '')}</h2>
        <p style="font-size:12.5px;color:var(--text-mute)">${U.esc(data.attempt.paper_title)} · ${U.relTime(data.attempt.created_at)} · 用时 ${fmtDuration(data.attempt.duration_ms)}</p>
      </div>
      <div class="card" style="padding:14px">
        <div class="row" style="gap:18px">
          <div class="tile"><span class="k">得分</span><span class="v">${data.attempt.right_count}<small>/ ${data.attempt.total}</small></span></div>
          <div class="tile"><span class="k">正确率</span><span class="v">${Math.round(data.attempt.right_count * 100 / data.attempt.total)}<small>%</small></span></div>
        </div>
      </div>
      <div>
        <div class="lbl" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-mute);font-weight:650;margin-bottom:8px">逐题回顾</div>
        ${data.detail.map((item) => `
          <div class="card" style="padding:12px;margin-bottom:9px;border-color:${item.correct ? 'rgba(16,185,129,.3)' : 'rgba(244,63,94,.3)'}">
            <div style="font-size:13.5px;line-height:1.6;margin-bottom:7px">
              <span style="font-family:var(--font-mono);color:var(--accent-text);font-weight:700;margin-right:6px">${item.q_number}</span>
              ${U.esc(item.stem)}
            </div>
            <div style="font-size:12.5px;color:var(--text-dim)">
              ${item.correct
                ? `<span style="color:var(--ok);font-weight:650">✓ 答对</span>（${item.chosen}）`
                : `<span style="color:var(--bad);font-weight:650">✗ 答错</span> 你选 ${item.chosen || '未作答'}，正确 <b>${item.answer}</b>`}
            </div>
            ${!item.correct && item.options.length ? `<div style="font-size:12.5px;color:var(--text-dim);margin-top:6px">
              ${item.options.filter((o) => o.label === item.answer).map((o) => `${o.label}) ${U.esc(o.text)}`).join('')}
            </div>` : ''}
            ${item.explanation ? `<details class="exp-details"${item.correct ? '' : ' open'}>
              <summary>解析</summary>
              <div>${U.esc(item.explanation)}</div>
            </details>` : ''}
          </div>`).join('')}
      </div>
      <div class="row" style="margin-top:auto;gap:8px">
        <button class="btn" style="flex:1" id="ad-redo">再做一遍</button>
        <button class="btn btn-primary" style="flex:1" id="ad-close">关闭</button>
      </div>
    `;
    document.body.appendChild(mask);
    document.body.appendChild(panel);
    panel.querySelector('.d-close').addEventListener('click', closeDrawer);
    panel.querySelector('#ad-close').addEventListener('click', closeDrawer);
    panel.querySelector('#ad-redo').addEventListener('click', () => {
      closeDrawer();
      openSet(data.attempt.set_id);
    });
  }

  function closeDrawer() {
    document.querySelectorAll('.drawer, .drawer-mask').forEach((n) => n.remove());
  }

  /* ------------------------------------------------------------------ */
  /* 题目错题                                                            */
  /* ------------------------------------------------------------------ */

  async function loadWrong() {
    root.innerHTML = `<div class="exam-shell"><div class="card"><div class="skel" style="height:18px;width:200px"></div></div></div>`;
    state.wrong = await API.examWrong({});
    paintWrong();
  }

  function paintWrong() {
    const w = state.wrong;
    frame(`
      <div class="page-head">
        <div>
          <h1>题目错题</h1>
          <div class="sub">做真题时答错的题，按错误次数排序；点进去可以重做整套</div>
        </div>
        ${tabs('wrong')}
      </div>

      ${w.items.length ? `
        <div class="card" style="padding:0;overflow:hidden">
          ${w.items.map((it) => `
            <div class="record-row" data-set="${it.set_id}">
              <div style="flex:1;min-width:0">
                <div class="ec-top" style="margin-bottom:3px">
                  <span class="chip ${it.level === 'cet6' ? 'reviewing' : 'new'}">${it.level === 'cet6' ? 'CET-6' : 'CET-4'}</span>
                  <span class="chip">${KIND[it.kind]}</span>
                  ${it.wrong_times > 1 ? `<span class="chip due">错过 ${it.wrong_times} 次</span>` : ''}
                </div>
                <div style="font-size:13.5px;line-height:1.6">
                  <span style="font-family:var(--font-mono);color:var(--accent-text);font-weight:700;margin-right:6px">${it.q_number}</span>
                  ${U.esc(it.stem)}
                </div>
                <div style="font-size:11.5px;color:var(--text-mute);margin-top:3px">${U.esc(it.code)} · ${U.esc(it.title || '')}</div>
              </div>
              <div style="text-align:right;flex:none">
                <div style="font-size:12.5px;color:var(--bad)">你选 ${it.chosen || '—'}</div>
                <div style="font-size:12.5px;color:var(--ok);font-weight:650">正确 ${it.answer}</div>
              </div>
            </div>`).join('')}
        </div>` : `<div class="card"><div class="empty">
          <div class="em-ico" style="background:var(--ok-soft);color:var(--ok)">${U.icon('award', 'ico')}</div>
          <h3>还没有答错过的题</h3>
          <p>做几套真题之后，答错的题会自动收集到这里，方便集中重做。</p>
          <button class="btn btn-primary" id="ex-tobank2">去题库</button>
        </div></div>`}
    `);

    bindTabs();
    const tb = document.getElementById('ex-tobank2');
    if (tb) tb.addEventListener('click', () => window.App.go('#/exam'));
    root.querySelectorAll('[data-set]').forEach((row) => {
      row.addEventListener('click', () => openSet(Number(row.dataset.set)));
    });
  }

  window.Views = window.Views || {};
  window.Views.exam = { render };
})();
