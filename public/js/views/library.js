/* 词库 —— 分类浏览、筛选、搜索、单词详情 */
(function () {
  'use strict';

  const U = window.UI;

  const state = {
    bookCode: '',
    unit: '',
    letter: 'ALL',
    status: 'all',
    sort: 'freq',
    q: '',
    page: 1,
    size: 50,
    data: null,
    units: [],
    letters: [],
    drawerOpen: false,
  };

  function reset(bookCode) {
    state.bookCode = bookCode || '';
    state.unit = '';
    state.letter = 'ALL';
    state.status = 'all';
    state.sort = 'freq';
    state.q = '';
    state.page = 1;
  }

  async function render(el) {
    const book = window.App.state.book;
    reset(book ? book.code : '');
    el.innerHTML = '<div id="lib-root"></div>';
    await load(true);
  }

  function root() {
    return document.getElementById('lib-root');
  }

  async function load(reloadMeta = false) {
    root().innerHTML = '<div class="card"><div class="skel" style="height:18px;width:200px;margin-bottom:12px"></div><div class="skel" style="height:14px"></div></div>';

    if (reloadMeta) {
      const [unitsRes, lettersRes, books] = await Promise.all([
        API.units(state.bookCode),
        API.letters(state.bookCode),
        API.books(),
      ]);
      state.units = unitsRes.units;
      state.letters = lettersRes;
      window.App.state.books = books;
      window.App.state.book = books.find((b) => b.code === state.bookCode) || window.App.state.book;
    }

    state.data = await API.words({
      book: state.bookCode,
      unit: state.unit,
      letter: state.letter,
      status: state.status,
      sort: state.sort,
      q: state.q,
      page: state.page,
      size: state.size,
    });

    paint();
  }

  function paint() {
    const books = window.App.state.books;
    const d = state.data;
    const unitsWithWord = state.units;

    root().innerHTML = `
      <div class="page-head">
        <div>
          <h1>词库</h1>
          <div class="sub">按词库 / 单元 / 首字母 / 学习状态自由筛选，点任意单词看详情</div>
        </div>
        <div class="row wrap">
          <span class="chip">共 <b style="color:var(--text)">${d.total}</b> 个词符合条件</span>
        </div>
      </div>

      <div class="book-tabs">
        ${books.map((b) => `
          <button class="book-tab ${b.code === state.bookCode ? 'on' : ''}" data-code="${b.code}"
                  style="--bk-accent:${U.esc(b.accent)}">
            <div class="bk-name">${U.esc(b.name)}</div>
            <div class="bk-meta">${b.started} / ${b.total} 已学 · 掌握 ${b.mastered}</div>
            <div class="bar"><i style="width:${b.percent}%"></i></div>
          </button>`).join('')}
      </div>

      <div class="filter-bar">
        <input class="input" id="f-q" placeholder="搜索单词或中文释义…" value="${U.esc(state.q)}">
        <select class="select" id="f-unit">
          <option value="">全部单元</option>
          ${unitsWithWord.map((u) => `
            <option value="${u.id}" ${String(state.unit) === String(u.id) ? 'selected' : ''}>
              ${U.esc(u.name)}（${u.total} 词${u.started ? ` · 已学 ${u.started}` : ''}）
            </option>`).join('')}
        </select>
        <select class="select" id="f-status">
          ${[
            ['all', '全部状态'],
            ['new', '未学'],
            ['learning', '学习中'],
            ['reviewing', '复习中'],
            ['mastered', '已掌握'],
            ['due', '待复习'],
            ['favorite', '已收藏'],
            ['suspended', '已暂缓（顽固词）'],
          ].map(([v, t]) => `<option value="${v}" ${state.status === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <select class="select" id="f-sort">
          ${[
            ['freq', '词频优先'],
            ['alpha', '字母顺序'],
            ['length', '词长排序'],
            ['wrong', '错误最多'],
            ['due', '到期最近'],
          ].map(([v, t]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <button class="btn btn-sm" id="f-reset">重置</button>
      </div>

      <div class="card" style="padding:12px 14px;margin-bottom:14px">
        <div class="row" style="margin-bottom:9px">
          <span style="font-size:12px;color:var(--text-mute);font-weight:600">按首字母</span>
          <span class="spacer"></span>
          <span style="font-size:11.5px;color:var(--text-mute)">数字为词库内该字母词数</span>
        </div>
        <div class="letter-strip" id="letters"></div>
      </div>

      ${d.items.length ? `
        <div class="word-list" id="word-list">
          ${d.items.map(row).join('')}
        </div>
        ${pager(d)}` : `
        <div class="card"><div class="empty">
          <div class="em-ico">${U.icon('search', 'ico')}</div>
          <h3>没有匹配的单词</h3>
          <p>换个关键词，或把筛选条件放宽一点试试。</p>
          <button class="btn" id="empty-reset">重置筛选</button>
        </div></div>`}
    `;

    paintLetters();

    root().querySelectorAll('.book-tab').forEach((b) => {
      b.addEventListener('click', async () => {
        const code = b.dataset.code;
        await window.App.setBook(code);
        reset(code);
        await load(true);
      });
    });

    document.getElementById('f-unit').addEventListener('change', (e) => {
      state.unit = e.target.value;
      state.page = 1;
      load(false);
    });
    document.getElementById('f-status').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(false); });
    document.getElementById('f-sort').addEventListener('change', (e) => { state.sort = e.target.value; state.page = 1; load(false); });
    document.getElementById('f-q').addEventListener('input', U.debounce((e) => {
      state.q = e.target.value.trim();
      state.page = 1;
      load(false).then(() => {
        const inp = document.getElementById('f-q');
        if (inp && state.q) {
          inp.focus();
          inp.setSelectionRange(inp.value.length, inp.value.length);
        }
      });
    }, 300));
    document.getElementById('f-reset').addEventListener('click', doReset);
    const er = document.getElementById('empty-reset');
    if (er) er.addEventListener('click', doReset);

    const list = document.getElementById('word-list');
    if (list) {
      list.addEventListener('click', (e) => {
        const fav = e.target.closest('.fav-btn');
        if (fav) {
          e.stopPropagation();
          toggleFav(fav.dataset.id, fav);
          return;
        }
        const r = e.target.closest('.word-row');
        if (r) openDrawer(r.dataset.id);
      });
    }

    root().querySelectorAll('[data-page]').forEach((b) => {
      b.addEventListener('click', () => {
        state.page = Number(b.dataset.page);
        load(false).then(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      });
    });
  }

  function doReset() {
    state.unit = '';
    state.letter = 'ALL';
    state.status = 'all';
    state.sort = 'freq';
    state.q = '';
    state.page = 1;
    load(false);
  }

  function paintLetters() {
    const box = document.getElementById('letters');
    if (!box) return;
    const counts = new Map(state.letters.map((l) => [l.letter, l.total]));
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    box.innerHTML = `<button class="letter-btn ${state.letter === 'ALL' ? 'on' : ''}" data-l="ALL">全部</button>` +
      letters.map((L) => `
        <button class="letter-btn ${state.letter === L ? 'on' : ''} ${counts.get(L) ? '' : 'empty'}"
                data-l="${L}" title="${counts.get(L) || 0} 个词">${L}</button>`).join('');

    box.addEventListener('click', (e) => {
      const b = e.target.closest('.letter-btn');
      if (!b) return;
      state.letter = b.dataset.l;
      state.page = 1;
      load(false);
    });
  }

  function row(w) {
    const due = w.due_at && new Date(w.due_at).getTime() <= Date.now() && w.status !== 'new';
    return `
      <div class="word-row" data-id="${w.id}">
        <div class="wr-spell">
          <b>${U.esc(w.spelling)}</b>
          <span>${w.phonetic ? '/' + U.esc(w.phonetic) + '/' : '&nbsp;'}</span>
        </div>
        <div class="wr-mean">${w.pos ? `<span style="color:var(--accent);font-family:var(--font-mono);font-size:12px">${U.esc(w.pos)}</span> ` : ''}${U.esc(U.meaningBrief(w.meaning, 70))}</div>
        <div class="wr-side">
          ${w.suspended ? '<span class="chip" title="已暂缓，不再进复习队列" style="color:var(--warn);background:var(--warn-soft);border-color:transparent">暂缓</span>' : ''}
          ${w.has_note ? `<span class="note-dot" title="有助记笔记">${U.icon('note')}</span>` : ''}
          ${U.statusChip(w.status, due)}
          <button class="fav-btn ${w.favorite ? 'on' : ''}" data-id="${w.id}" title="收藏">${U.icon('star')}</button>
        </div>
      </div>`;
  }

  function pager(d) {
    if (d.pages <= 1) {
      return `<div class="pager">共 ${d.total} 个词 · 第 ${d.page}/${d.pages} 页</div>`;
    }
    const pages = [];
    const cur = d.page;
    for (let i = 1; i <= d.pages; i++) {
      if (i === 1 || i === d.pages || Math.abs(i - cur) <= 2) pages.push(i);
      else if (pages[pages.length - 1] !== '…') pages.push('…');
    }

    return `<div class="pager">
      <button class="btn btn-sm" data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>${U.icon('arrowLeft')} 上一页</button>
      ${pages.map((p) => p === '…'
        ? '<span style="color:var(--text-mute)">…</span>'
        : `<button class="btn btn-sm ${p === cur ? 'btn-primary' : ''}" data-page="${p}">${p}</button>`).join('')}
      <button class="btn btn-sm" data-page="${cur + 1}" ${cur >= d.pages ? 'disabled' : ''}>下一页 ${U.icon('arrowRight')}</button>
      <span style="margin-left:8px">共 ${d.total} 个词</span>
    </div>`;
  }

  async function toggleFav(id, btn) {
    try {
      const r = await API.favorite(Number(id));
      btn.classList.toggle('on', !!r.favorite);
      U.toast(r.favorite ? '已加入收藏' : '已取消收藏', 'ok');
    } catch (err) {
      U.toast(err.message, 'bad');
    }
  }

  /* ----------------------------- 详情抽屉 ----------------------------- */

  async function openDrawer(id) {
    let d;
    try {
      d = await API.word(Number(id));
    } catch (err) {
      return U.toast(err.message, 'bad');
    }

    closeDrawer();
    const w = d.word;
    const p = d.progress;
    const parts = U.splitMeaning(w.meaning);

    const mask = document.createElement('div');
    mask.className = 'drawer-mask';
    mask.addEventListener('click', closeDrawer);

    const panel = document.createElement('aside');
    panel.className = 'drawer';
    panel.id = 'word-drawer';
    panel.innerHTML = `
      <button class="btn btn-icon btn-ghost d-close">${U.icon('x')}</button>

      <div>
        <div class="row" style="gap:10px;margin-bottom:2px">
          <h2 style="font-size:27px;letter-spacing:-.03em">${U.esc(w.spelling)}</h2>
          <button class="speak-btn" id="d-speak">${U.icon('speaker')}</button>
        </div>
        ${w.phonetic ? `<div class="word-phon">/${U.esc(w.phonetic)}/</div>` : ''}
        <div class="row wrap" style="gap:6px;margin-top:9px">
          ${w.pos ? w.pos.split(' ').map((x) => `<span class="chip pos">${U.esc(x)}</span>`).join('') : ''}
          ${U.collinsStars(w.collins)}
          ${w.oxford ? '<span class="chip" style="color:var(--info);background:var(--info-soft);border-color:transparent">牛津3000</span>' : ''}
        </div>
      </div>

      <div class="card" style="padding:14px">
        <div class="row" style="gap:8px">
          ${U.statusChip(p ? p.status : 'new', p && p.due_at && new Date(p.due_at) <= new Date())}
          ${p && p.stage !== undefined ? `<span class="chip">记忆阶段 ${p.stage}/${d.maxStage}</span>` : ''}
          ${p && p.reps ? `<span class="chip">已过关 ${p.reps} 次</span>` : ''}
          ${p && p.suspended ? '<span class="chip" style="color:var(--warn);background:var(--warn-soft);border-color:transparent">已暂缓</span>' : ''}
          <span class="spacer"></span>
          <button class="fav-btn ${p && p.favorite ? 'on' : ''}" id="d-fav" style="width:30px;height:30px;border:1px solid var(--border);border-radius:9px;display:grid;place-items:center">
            ${U.icon('star')}
          </button>
        </div>
        ${p && p.due_at ? `<div style="font-size:12.5px;color:var(--text-mute);margin-top:9px">
          下次复习：${U.fmtDate(p.due_at)}（${U.fmtDue(p.due_at)}）
        </div>` : ''}
      </div>

      <div>
        <div class="lbl" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-mute);font-weight:650;margin-bottom:7px">助记笔记</div>
        <textarea class="note-input" id="d-note" rows="2" maxlength="500"
          placeholder="写点自己的记忆法：词根、谐音、场景联想…（失焦自动保存）">${U.esc(p && p.note ? p.note : '')}</textarea>
        <div class="row" style="gap:8px;margin-top:7px;align-items:center">
          <span style="font-size:11.5px;color:var(--text-mute)" id="d-note-state">${p && p.note ? '已保存' : '还没写'}</span>
          <span class="spacer"></span>
          <button class="btn btn-sm" id="d-suspend">${p && p.suspended ? U.icon('play') + ' 恢复复习' : U.icon('pause') + ' 暂缓'}</button>
        </div>
      </div>

      <div>
        <div class="lbl" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-mute);font-weight:650;margin-bottom:7px">释义</div>
        <div class="meaning-list">
          ${parts.map((x, i) => `<div class="meaning-item"><span class="idx">${i + 1}</span>
            <span class="txt">${x.pos ? `<em>${U.esc(x.pos)}</em>` : ''}${U.esc(x.text)}</span></div>`).join('')}
        </div>
      </div>

      ${w.exchange ? block('词形变化', U.esc(w.exchange)) : ''}
      ${w.definition ? block('英文释义', U.esc(w.definition)) : ''}
      ${w.meaning_alt ? block('专业释义', U.esc(w.meaning_alt)) : ''}
      ${block('所属词库', d.books.map((b) => `${U.esc(b.short_name)} · ${U.esc(b.unit_name || '')}`).join('<br>'))}
      ${w.frq ? block('语料库词频', `当代语料库排名 #${w.frq}${w.bnc ? ` · BNC 排名 #${w.bnc}` : ''}`) : ''}

      <div>
        <div class="lbl" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-mute);font-weight:650;margin-bottom:7px">练习记录</div>
        <div style="font-size:12.5px;color:var(--text-dim);display:flex;flex-direction:column;gap:5px">
          <span>翻卡：认识 ${p ? p.known_count : 0} · 模糊 ${p ? p.vague_count : 0} · 不认识 ${p ? p.unknown_count : 0}</span>
          <span>测试：答对 ${p ? p.quiz_right : 0} · 答错 ${p ? p.quiz_wrong : 0}</span>
          ${d.recent.length ? `<span style="color:var(--text-mute);margin-top:4px">最近 ${d.recent.length} 条：${d.recent.slice(0, 5).map((r) => `${r.mode === 'quiz' ? '测' : '卡'}:${r.rating}(${r.day.slice(5)})`).join(' · ')}</span>` : ''}
        </div>
      </div>

      <div class="row" style="margin-top:auto;gap:8px">
        <button class="btn" style="flex:1" id="d-reset">${U.icon('refresh')} 重置进度</button>
        <button class="btn btn-primary" style="flex:1" id="d-close2">关闭</button>
      </div>
    `;

    document.body.appendChild(mask);
    document.body.appendChild(panel);
    state.drawerOpen = true;

    const close = () => closeDrawer();
    panel.querySelector('.d-close').addEventListener('click', close);
    panel.querySelector('#d-close2').addEventListener('click', close);
    panel.querySelector('#d-speak').addEventListener('click', () => U.speak(w.spelling, window.App.state.settings.accent));
    panel.querySelector('#d-fav').addEventListener('click', async (e) => {
      const r = await API.favorite(w.id);
      e.currentTarget.classList.toggle('on', !!r.favorite);
      // 同步列表里的星标
      const rowBtn = root().querySelector(`.fav-btn[data-id="${w.id}"]`);
      if (rowBtn) rowBtn.classList.toggle('on', !!r.favorite);
    });
    panel.querySelector('#d-reset').addEventListener('click', async () => {
      try {
        await API.resetWord(w.id);
        U.toast('已重置该词的学习进度', 'ok');
        closeDrawer();
        load(false);
        window.App.refreshBadges();
      } catch (err) {
        U.toast(err.message, 'bad');
      }
    });

    /* ---- 助记笔记：失焦自动保存 ---- */
    const noteEl = panel.querySelector('#d-note');
    const noteState = panel.querySelector('#d-note-state');
    let savedNote = p && p.note ? p.note : '';
    noteEl.addEventListener('blur', async () => {
      const val = noteEl.value.trim();
      if (val === savedNote) return;
      noteState.textContent = '保存中…';
      try {
        const r = await API.saveNote(w.id, val);
        savedNote = r.note;
        noteEl.value = r.note;
        noteState.textContent = r.saved ? '已保存' : '还没写';
        U.toast(r.saved ? '笔记已保存' : '笔记已清除', 'ok');
        load(false);          // 刷新列表里的「有笔记」标记
      } catch (err) {
        noteState.textContent = '保存失败';
        U.toast(err.message, 'bad');
      }
    });

    /* ---- 顽固词：暂缓 / 恢复 ---- */
    const susBtn = panel.querySelector('#d-suspend');
    susBtn.addEventListener('click', async () => {
      try {
        const r = await API.suspendWord(w.id);
        U.toast(r.suspended ? '已暂缓：不再进复习队列' : '已恢复复习', r.suspended ? 'ok' : 'ok');
        closeDrawer();
        load(false);
        window.App.refreshBadges();
      } catch (err) {
        U.toast(err.message, 'bad');
      }
    });
  }

  function block(label, html) {
    return `<div class="detail-block">
      <div class="lbl" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-mute);font-weight:650;margin-bottom:5px">${label}</div>
      <div class="body" style="font-size:13.5px;color:var(--text-dim);line-height:1.7">${html}</div>
    </div>`;
  }

  function closeDrawer() {
    document.querySelectorAll('.drawer, .drawer-mask').forEach((n) => n.remove());
    state.drawerOpen = false;
  }

  window.Views = window.Views || {};
  window.Views.library = {
    render,
    cleanup: () => { if (state.drawerOpen) closeDrawer(); },
  };
})();
