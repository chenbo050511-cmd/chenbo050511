/* 测试 —— 选择题模式 */
(function () {
  'use strict';

  const U = window.UI;

  const state = {
    phase: 'setup',     // setup | playing | result
    questions: [],
    sessionId: '',      // 服务端判分用：提交时要带上
    idx: 0,
    answered: [],
    locked: false,
    config: { scope: 'all', count: 10, type: 'mix' },
    lastMistakes: [],
  };

  let keyHandler = null;

  function reset(bookCode) {
    state.phase = 'setup';
    state.questions = [];
    state.sessionId = '';
    state.idx = 0;
    state.answered = [];
    state.locked = false;
    state.lastMistakes = [];
    if (bookCode) state.bookCode = bookCode;
  }

  async function render(el) {
    const book = window.App.state.book;
    reset(book ? book.code : '');
    state.bookCode = book ? book.code : '';
    state.config.count = Number(window.App.state.settings.quiz_count) || 10;
    state.config.type = window.App.state.settings.quiz_type || 'mix';

    el.innerHTML = '<div id="quiz-root" class="quiz-shell"></div>';
    paintSetup();

    window.App._cleanup = () => {
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    };
  }

  function root() {
    return document.getElementById('quiz-root');
  }

  /* ----------------------------- 出题前 ----------------------------- */

  function paintSetup() {
    state.phase = 'setup';
    const books = window.App.state.books;
    root().innerHTML = `
      <div class="page-head" style="margin-bottom:0">
        <div>
          <h1>测试</h1>
          <div class="sub">从词库里抽题，四选一，答错自动回到复习队列</div>
        </div>
      </div>

      <div class="card pad-lg">
        <div class="grid g-2" style="gap:20px">
          <div class="field">
            <label>词库</label>
            <select class="select" id="q-book">
              ${books.map((b) => `<option value="${b.code}" ${b.code === state.bookCode ? 'selected' : ''}>
                ${U.esc(b.short_name)} · ${b.total} 词</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>出题范围</label>
            <select class="select" id="q-scope">
              <option value="all">整个词库随机</option>
              <option value="started">只考学过的词</option>
              <option value="due">只考到期待复习的词</option>
            </select>
          </div>
          <div class="field">
            <label>题量</label>
            <div class="seg" id="q-count" style="width:fit-content">
              ${[10, 20, 30, 50].map((n) => `<button data-v="${n}" class="${n === state.config.count ? 'on' : ''}">${n} 题</button>`).join('')}
            </div>
          </div>
          <div class="field">
            <label>题型</label>
            <div class="seg" id="q-type" style="width:fit-content">
              <button data-v="mix" class="${state.config.type === 'mix' ? 'on' : ''}">混合</button>
              <button data-v="en2cn" class="${state.config.type === 'en2cn' ? 'on' : ''}">英 → 中</button>
              <button data-v="cn2en" class="${state.config.type === 'cn2en' ? 'on' : ''}">中 → 英</button>
            </div>
          </div>
        </div>

        <div class="row" style="margin-top:22px;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary btn-lg" id="start">${U.icon('zap')} 开始答题</button>
          <span style="font-size:12.5px;color:var(--text-mute)">答题时可用键盘 <kbd style="border:1px solid var(--border);border-radius:4px;padding:0 5px">1–4</kbd> 快速选择</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><h3>为什么要做测试</h3></div>
        <div class="grid g-3" style="gap:14px">
          ${tip('target', '主动回忆', '翻卡是「看到才想起」，选择题是「主动想起来」，后者对记忆的加固效果更强。')}
          ${tip('refresh', '答错重排', '选错的词会立刻被打回记忆阶段 0，5 分钟后重新出现在复习队列里。')}
          ${tip('trendingUp', '进度互通', '测试结果直接写进同一套进度，和翻卡学习的排期完全共享。')}
        </div>
      </div>
    `;

    const seg = (id, key) => {
      const box = document.getElementById(id);
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        box.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        state.config[key] = key === 'count' ? Number(b.dataset.v) : b.dataset.v;
      });
    };
    seg('q-count', 'count');
    seg('q-type', 'type');

    document.getElementById('q-book').addEventListener('change', async (e) => {
      state.bookCode = e.target.value;
      await window.App.setBook(e.target.value);
    });
    document.getElementById('q-scope').addEventListener('change', (e) => {
      state.config.scope = e.target.value;
    });

    document.getElementById('start').addEventListener('click', start);
  }

  function tip(icon, title, body) {
    return `<div style="display:flex;gap:11px">
      <div style="flex:none;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)">
        ${U.icon(icon)}
      </div>
      <div>
        <b style="font-size:13.5px">${title}</b>
        <p style="font-size:12.5px;color:var(--text-mute);line-height:1.6">${body}</p>
      </div>
    </div>`;
  }

  /* ----------------------------- 答题中 ----------------------------- */

  async function start() {
    const btn = document.getElementById('start');
    btn.disabled = true;
    btn.textContent = '出题中…';
    try {
      const data = await API.quiz({
        book: state.bookCode,
        count: state.config.count,
        type: state.config.type,
        scope: state.config.scope,
      });
      if (!data.questions || !data.questions.length) {
        U.toast(data.message || '该范围内没有可出题的单词', 'bad');
        btn.disabled = false;
        btn.innerHTML = U.icon('zap') + ' 开始答题';
        return;
      }
      state.questions = data.questions;
      state.sessionId = data.sessionId || '';
      state.idx = 0;
      state.answered = [];
      state.locked = false;
      state.phase = 'playing';
      paintQuestion();
    } catch (err) {
      U.toast(err.message, 'bad');
      btn.disabled = false;
      btn.innerHTML = U.icon('zap') + ' 开始答题';
    }
  }

  function paintQuestion() {
    const q = state.questions[state.idx];
    if (!q) return paintResult();

    const isEn = q.type === 'en2cn';
    const total = state.questions.length;
    const rightCount = state.answered.filter((a) => a.correct).length;

    root().innerHTML = `
      <div class="study-top">
        <button class="btn btn-sm btn-ghost" id="quit">${U.icon('arrowLeft')} 结束</button>
        <div class="study-counter">
          <span>第 <b>${state.idx + 1}</b> / ${total} 题</span>
          <span class="sep">·</span>
          <span>答对 <b style="color:var(--ok)">${rightCount}</b></span>
        </div>
        <span class="spacer"></span>
        <span class="chip">${isEn ? '英 → 中' : '中 → 英'}</span>
      </div>

      <div class="bar"><i style="width:${(state.idx / total) * 100}%"></i></div>

      <div class="quiz-prompt">
        <div class="q-tag">${isEn ? '选出正确的中文释义' : '选出对应的英文单词'}</div>
        <div class="q-main ${isEn ? '' : 'cn'}">${U.esc(q.prompt)}</div>
        ${isEn && q.phonetic ? `<div class="q-sub">/${U.esc(q.phonetic)}/</div>` : ''}
        ${!isEn && q.pos ? `<div class="row wrap" style="justify-content:center;gap:6px;margin-top:8px">
          ${q.pos.split(' ').map((p) => `<span class="chip pos">${U.esc(p)}</span>`).join('')}</div>` : ''}
      </div>

      <div class="options" id="options">
        ${q.options.map((o, i) => `
          <button class="option" data-i="${i}">
            <span class="mark">${'ABCD'[i]}</span>
            <span>${U.esc(o.text)}</span>
          </button>`).join('')}
      </div>

      <div class="srs-toast" id="quiz-fb" style="min-height:22px"></div>
    `;

    document.getElementById('quit').addEventListener('click', finish);
    document.getElementById('options').addEventListener('click', (e) => {
      const btn = e.target.closest('.option');
      if (!btn) return;
      pick(Number(btn.dataset.i));
    });

    keyHandler = (e) => {
      if (state.phase !== 'playing') return;
      const n = Number(e.key);
      if (n >= 1 && n <= 4) pick(n - 1);
    };
    document.addEventListener('keydown', keyHandler);
  }

  function pick(i) {
    if (state.locked) return;
    const q = state.questions[state.idx];
    const chosen = q.options[i];
    if (!chosen) return;
    state.locked = true;

    /* 前端**不知道**正确答案是哪个（服务端没下发），
       所以这里只标记「你选了哪个」，对错等交卷后由服务端告诉我们。
       这样也就杜绝了「在 devtools 里读出答案」这件事。 */
    document.querySelectorAll('.option').forEach((btn, bi) => {
      btn.disabled = true;
      if (bi === i) btn.classList.add('picked');
      else btn.classList.add('dim');
    });

    state.answered.push({
      index: state.idx,             // 交给服务端定位题目（中途结束也对得准）
      wordId: q.wordId,
      chosen: chosen.key || '',     // 只提交「选了哪个」
      chosenText: chosen.text,
      correct: null,                // 交卷后由服务端回填
      answer: '',
      prompt: q.prompt,
    });

    const fb = document.getElementById('quiz-fb');
    fb.innerHTML = `<span style="color:var(--text-dim);font-weight:600">已作答，交卷后给结果</span>`;

    // 交卷前不再剧透，所以答完立刻翻到下一题
    setTimeout(() => {
      state.locked = false;
      state.idx += 1;
      if (state.idx >= state.questions.length) finish();
      else paintQuestion();
    }, 420);
  }

  /* ----------------------------- 结算 ----------------------------- */

  /**
   * 成绩没能落库时的提示。
   *
   * 这里**不猜对错**：判分只认服务端，所以服务端不受理时我们只能说
   * 「这次没能记录」。以前会显示成「你全错了」，用户会以为考砸了，
   * 实际上成绩压根没进数据库、排期也没动。
   */
  function paintSaveFailed(message) {
    const n = state.answered.length;
    root().innerHTML = `
      <div class="card pad-lg quiz-result">
        <div class="em-ico" style="background:var(--warn-soft);color:var(--warn);margin:0 auto 14px">
          ${U.icon('x', 'ico')}
        </div>
        <h3 style="margin-bottom:6px">这次成绩没能记录</h3>
        <p style="color:var(--text-dim);font-size:13.5px;line-height:1.7;max-width:460px;margin:0 auto">
          你已经答了 <b>${n}</b> 题，但服务端没有受理这次提交，
          所以<b>对错没有计入，复习排期也没有改动</b>。
          ${message ? `<br><span style="color:var(--text-mute);font-size:12.5px">原因：${U.esc(message)}</span>` : ''}
        </p>
        <p style="color:var(--text-mute);font-size:12.5px;margin-top:12px">
          常见原因：出题之后服务重启过，或者放着超过了 2 小时（这组题的答案已经失效）。
          重新出一组题就好，<b>不会重复计分</b>。
        </p>
        <div class="row" style="justify-content:center;gap:10px;margin-top:20px;flex-wrap:wrap">
          <button class="btn btn-primary" id="retry-set">${U.icon('refresh')} 重新出一组</button>
          <button class="btn" id="back-today">${U.icon('arrowLeft')} 回今日</button>
        </div>
      </div>`;

    document.getElementById('retry-set').addEventListener('click', () => { reset(); paintSetup(); });
    document.getElementById('back-today').addEventListener('click', () => window.App.go('#/today'));
  }

  async function finish() {
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    state.phase = 'result';

    const answered = state.answered;
    if (!answered.length) {
      paintSetup();
      return;
    }

    let data = null;
    let saveError = '';
    try {
      data = await API.submitQuiz(
        state.bookCode,
        // 只提交「选了哪个」；对错由服务端拿它自己的答案判定
        answered.map((a) => ({ index: a.index, wordId: a.wordId, chosen: a.chosen })),
        state.sessionId
      );
    } catch (err) {
      saveError = err.message || '未知错误';
      U.toast('成绩保存失败：' + saveError, 'bad');
    }

    /* 服务端拒绝受理（会话失效 / 重复提交）时，**不要**在这里自己判分。
       以前这里会把没回填的题一律当答错，于是「服务重启过」这种情况
       会显示成「你全错了」，而实际成绩根本没被记录 —— 用户以为考砸了。 */
    const graded = !!(data && data.graded === 'server' && Array.isArray(data.results));
    if (!graded) {
      return paintSaveFailed(saveError);
    }

    /* 用服务端回传的结果回填每一题的对错与正确答案。
       服务端会给出 correctKey（正确答案是哪个选项），
       前端再从自己的题目数据里把它翻成文字 —— 答题过程中前端是没有这份信息的。 */
    data.results.forEach((r) => {
      const a = answered.find((x) => x.index === r.index);
      if (!a) return;
      a.correct = !!r.correct;
      const q = state.questions[r.index];
      const opt = q && q.options.find((o) => o.key === r.correctKey);
      a.answer = opt ? opt.text : '';
    });
    // 没被回填的按答错显示（正常情况下不该出现）
    answered.forEach((a) => { if (a.correct === null) a.correct = false; });

    const total = answered.length;
    const right = answered.filter((a) => a.correct).length;
    const wrongList = answered.filter((a) => !a.correct);
    const acc = total ? Math.round((right / total) * 100) : 0;
    const verdict = acc >= 90 ? '状态很稳，继续保持' : acc >= 70 ? '基础不错，错题再过一遍' : acc >= 50 ? '还有不少漏洞，建议回去翻卡' : '这组偏难，先把错题啃下来';

    root().innerHTML = `
      <div class="card pad-lg quiz-result">
        <div class="q-tag" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-mute);font-weight:650">本轮得分</div>
        <div class="score-big">${right}<span style="font-size:26px;color:var(--text-mute);font-weight:600"> / ${total}</span></div>
        <p style="color:var(--text-dim);font-size:13.5px;margin-top:4px">正确率 ${acc}% · ${verdict}</p>

        <div class="grid g-3" style="margin:22px 0;gap:12px">
          <div class="tile" style="align-items:center"><span class="k">答对</span><span class="v" style="color:var(--ok)">${right}</span></div>
          <div class="tile" style="align-items:center"><span class="k">答错</span><span class="v" style="color:var(--bad)">${total - right}</span></div>
          <div class="tile" style="align-items:center"><span class="k">错题重排</span><span class="v">${wrongList.length}<small>5 分钟后</small></span></div>
        </div>

        <div class="row" style="justify-content:center;flex-wrap:wrap;gap:10px">
          <button class="btn btn-primary" id="again">${U.icon('refresh')} 再来一组</button>
          ${wrongList.length ? `<button class="btn" id="review-wrong">${U.icon('list')} 只看错题</button>` : ''}
          <button class="btn" id="to-study">${U.icon('brain')} 去翻卡学习</button>
        </div>
      </div>

      ${wrongList.length ? `<div class="card">
        <div class="card-title">
          <h3>本轮错题</h3>
          <span class="hint">这些词已经回到复习队列</span>
        </div>
        <div class="mistake-list">
          ${wrongList.map((a) => `
            <div class="mistake-row">
              <span class="w">${U.esc(a.prompt)}</span>
              <span class="m">你选：<s style="opacity:.7">${U.esc(a.chosenText || '')}</s> → 正确：${U.esc(a.answer)}</span>
            </div>`).join('')}
        </div>
      </div>` : `<div class="card"><div class="empty" style="padding:26px">
        <div class="em-ico" style="background:var(--ok-soft);color:var(--ok)">${U.icon('award', 'ico')}</div>
        <h3>全对，无可挑剔</h3>
        <p>这一组没有错题。可以把题量加到 30 或 50，往更深处试试。</p>
      </div></div>`}
    `;

    document.getElementById('again').addEventListener('click', () => { reset(); paintSetup(); });
    const rw = document.getElementById('review-wrong');
    if (rw) {
      rw.addEventListener('click', () => window.App.go('#/mistakes'));
    }
    document.getElementById('to-study').addEventListener('click', () => window.App.go('#/study'));

    window.App.refreshBadges();
  }

  window.Views = window.Views || {};
  window.Views.quiz = { render };
})();
