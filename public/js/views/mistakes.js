/* 错题本 —— 把答错过的词集中过一遍 */
(function () {
  'use strict';

  const U = window.UI;

  async function render(el) {
    el.innerHTML = '<div id="mk-root"></div>';
    await load();
  }

  function root() {
    return document.getElementById('mk-root');
  }

  async function load() {
    const book = window.App.state.book;
    const code = book ? book.code : '';
    root().innerHTML = '<div class="card"><div class="skel" style="height:16px;width:220px"></div></div>';

    const [data, overview, leeches] = await Promise.all([
      API.mistakes(code, 300),
      API.overview(),
      API.leeches(code, 100),
    ]);

    const leechOpen = leeches.items.filter((x) => !x.suspended);
    const leechDone = leeches.items.filter((x) => x.suspended);

    root().innerHTML = `
      <div class="page-head">
        <div>
          <h1>错题本</h1>
          <div class="sub">答错过的词会自动回到复习队列，这里可以集中复盘</div>
        </div>
        <div class="row wrap">
          <span class="chip due">共 ${data.total} 个待攻克</span>
        </div>
      </div>

      <div class="grid g-3" style="margin-bottom:16px">
        <div class="card tile">
          <span class="k">${U.icon('x')} 测试答错</span>
          <span class="v" style="color:var(--bad)">${overview.wrong_words}</span>
          <span style="font-size:11.5px;color:var(--text-mute)">选择题答错的词数</span>
        </div>
        <div class="card tile">
          <span class="k">${U.icon('trendingUp')} 累计正确率</span>
          <span class="v">${overview.accuracy}<small>%</small></span>
          <span style="font-size:11.5px;color:var(--text-mute)">共 ${overview.totalReviews} 次练习</span>
        </div>
        <div class="card tile">
          <span class="k">${U.icon('brain')} 复习中</span>
          <span class="v">${overview.reviewing}</span>
          <span style="font-size:11.5px;color:var(--text-mute)">已过初学阶段、仍在巩固</span>
        </div>
      </div>

      ${leechOpen.length ? `
        <div class="card leech-card">
          <div class="card-title">
            <h3>顽固词 ${leechOpen.length} 个</h3>
            <span class="hint">累计错 ${leeches.threshold} 次以上 —— 光靠重复很难记住，建议换个记法</span>
          </div>
          <p style="font-size:12.5px;color:var(--text-dim);line-height:1.7;margin-bottom:12px">
            这些词每次都会排在复习队列最前面，一直啃不动就会一直占用你的时间。
            三个出路：<b>写句助记</b>换个记忆角度、<b>暂缓</b>先放一放（不再进复习队列）、
            或者<b>移出错题本</b>（如果你觉得它不值得花时间）。
            暂缓的词不会丢，随时能在下面的「已暂缓」里恢复。
          </p>
          <div id="mk-leech">${leechOpen.map(leechRow).join('')}</div>
        </div>` : ''}

      ${leechDone.length ? `
        <div class="card">
          <div class="card-title">
            <h3>已暂缓 ${leechDone.length} 个</h3>
            <span class="hint">不再进复习队列，随时可以恢复</span>
          </div>
          <div id="mk-leech-done">${leechDone.map(leechRow).join('')}</div>
        </div>` : ''}

      ${data.items.length ? `
        <div class="card" style="padding:0;overflow:hidden">
          <div style="padding:14px 16px;border-bottom:1px solid var(--border)" class="row">
            <b style="font-size:14px">按错误次数排序</b>
            <span class="spacer"></span>
            <button class="btn btn-sm btn-primary" id="mk-quiz">${U.icon('check')} 去测试巩固</button>
            <button class="btn btn-sm" id="mk-study">${U.icon('brain')} 去翻卡</button>
          </div>
          <div id="mk-list">
            ${data.items.map(row).join('')}
          </div>
        </div>` : `
        <div class="card"><div class="empty">
          <div class="em-ico" style="background:var(--ok-soft);color:var(--ok)">${U.icon('award', 'ico')}</div>
          <h3>错题本是空的</h3>
          <p>还没有答错过的词。去「测试」页做一组题，答错的词会自动收集到这里。</p>
          <button class="btn btn-primary" id="mk-goto-quiz">${U.icon('check')} 开始一组测试</button>
        </div></div>`}
    `;

    const q = document.getElementById('mk-quiz');
    if (q) q.addEventListener('click', () => window.App.go('#/quiz'));
    const s = document.getElementById('mk-study');
    if (s) s.addEventListener('click', () => window.App.go('#/study'));
    const gq = document.getElementById('mk-goto-quiz');
    if (gq) gq.addEventListener('click', () => window.App.go('#/quiz'));

    const list = document.getElementById('mk-list');
    if (list) bindRowEvents(list);

    /* 顽固词区（待处理 / 已暂缓）用同一套事件 */
    const leechBox = document.getElementById('mk-leech');
    if (leechBox) bindRowEvents(leechBox, { useLeechRow: true });
    const leechDoneBox = document.getElementById('mk-leech-done');
    if (leechDoneBox) bindRowEvents(leechDoneBox, { useLeechRow: true });

    window.App._cleanup = () => { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); };
  }

  /**
   * 单词行的公共事件：朗读 / 暂缓 / 移出错题本 / 看详情。
   * 错题列表和顽固词列表都用它，避免两处逻辑走偏。
   */
  function bindRowEvents(container, opts = {}) {
    // 失焦保存助记（只有顽固词区有输入框）
    container.addEventListener('focusout', (e) => {
      const ta = e.target.closest('[data-act="note"]');
      if (ta) saveNote(ta);
    }, true);

    container.addEventListener('click', async (e) => {
      const speakBtn = e.target.closest('[data-act="speak"]');
      if (speakBtn) {
        U.speak(speakBtn.dataset.w, window.App.state.settings.accent);
        return;
      }

      const detailBtn = e.target.closest('[data-act="detail"]');
      if (detailBtn) {
        window.App.go('#/library');
        return;
      }

      const susBtn = e.target.closest('[data-act="suspend"]');
      if (susBtn) {
        try {
          const r = await API.suspendWord(Number(susBtn.dataset.id));
          U.toast(r.suspended ? '已暂缓：不再进复习队列' : '已恢复复习', 'ok');
          load();
          window.App.refreshBadges();
        } catch (err) {
          U.toast(err.message, 'bad');
        }
        return;
      }

      const clearBtn = e.target.closest('[data-act="clear"]');
      if (clearBtn) {
        try {
          await API.clearMistake(Number(clearBtn.dataset.id));
          U.toast('已移出错题本', 'ok');
          load();
          window.App.refreshBadges();
        } catch (err) {
          U.toast(err.message, 'bad');
        }
      }
    });
  }

  /**
   * 顽固词行：比普通错题行多两样东西 ——
   * 一个「错了几次」的醒目计数，一个展开就能写的助记框。
   * 助记是处理顽固词最有效的手段（换个记忆角度），所以直接放在这里，
   * 不用跳去词库页。
   */
  function leechRow(w) {
    return `
      <div class="leech-row" data-id="${w.id}">
        <div class="row" style="gap:9px;align-items:baseline">
          <b style="font-size:15.5px">${U.esc(w.spelling)}</b>
          ${w.phonetic ? `<span style="font-size:12px;color:var(--text-mute)">/${U.esc(w.phonetic)}/</span>` : ''}
          <span class="chip" style="color:var(--bad);background:var(--bad-soft);border-color:transparent"
                title="测试答错 ${w.quiz_wrong} 次 · 翻卡标记不认识 ${w.unknown_count} 次">错 ${w.lapses} 次</span>
          ${w.suspended ? '<span class="chip" style="color:var(--warn);background:var(--warn-soft);border-color:transparent">已暂缓</span>' : ''}
          <span class="spacer"></span>
          <button class="fav-btn" data-act="speak" data-w="${U.esc(w.spelling)}" title="朗读">${U.icon('speaker')}</button>
        </div>
        <div style="font-size:12.5px;color:var(--text-dim);margin-top:4px">${U.esc(U.meaningBrief(w.meaning, 80))}</div>
        <textarea class="note-input" data-act="note" rows="1" maxlength="500"
          placeholder="写点自己的记法（词根 / 谐音 / 场景）… 失焦自动保存">${U.esc(w.note || '')}</textarea>
        <div class="row" style="gap:8px;margin-top:7px">
          <button class="btn btn-sm" data-act="suspend" data-id="${w.id}" data-on="${w.suspended ? 1 : 0}">
            ${w.suspended ? U.icon('play') + ' 恢复复习' : U.icon('pause') + ' 暂缓'}
          </button>
          <button class="btn btn-sm" data-act="clear" data-id="${w.id}">${U.icon('check')} 移出错题本</button>
          <button class="btn btn-sm btn-ghost" data-act="detail" data-id="${w.id}">${U.icon('info')} 详情</button>
        </div>
      </div>`;
  }

  /** 助记失焦保存（顽固词框和普通错题框共用） */
  async function saveNote(el) {
    const id = Number(el.closest('[data-id]').dataset.id);
    const val = el.value.trim();
    if (el.dataset.saved === val) return;
    try {
      const r = await API.saveNote(id, val);
      el.value = r.note;
      el.dataset.saved = r.note;
      U.toast(r.saved ? '助记已保存' : '助记已清除', 'ok');
    } catch (err) {
      U.toast('助记保存失败：' + err.message, 'bad');
    }
  }

  function row(w) {
    const totalWrong = w.quiz_wrong + w.unknown_count;
    return `
      <div class="word-row" style="cursor:default" data-id="${w.id}">
        <div class="wr-spell">
          <b>${U.esc(w.spelling)}</b>
          <span>${w.phonetic ? '/' + U.esc(w.phonetic) + '/' : '&nbsp;'}</span>
        </div>
        <div class="wr-mean">${w.pos ? `<span style="color:var(--accent);font-family:var(--font-mono);font-size:12px">${U.esc(w.pos)}</span> ` : ''}${U.esc(U.meaningBrief(w.meaning, 60))}</div>
        <div class="wr-side">
          <span class="chip due" title="测试答错 ${w.quiz_wrong} 次，翻卡标记不认识 ${w.unknown_count} 次">错 ${totalWrong} 次</span>
          <span class="chip">阶段 ${w.stage}</span>
          <button class="fav-btn" data-act="speak" data-w="${U.esc(w.spelling)}" title="朗读">${U.icon('speaker')}</button>
          <button class="fav-btn" data-act="suspend" data-id="${w.id}" data-on="${w.suspended ? 1 : 0}"
                  title="${w.suspended ? '恢复复习' : '暂缓（不再进复习队列）'}">${w.suspended ? U.icon('play') : U.icon('pause')}</button>
          <button class="fav-btn" data-act="clear" data-id="${w.id}" title="移出错题本">${U.icon('check')}</button>
        </div>
      </div>`;
  }

  window.Views = window.Views || {};
  window.Views.mistakes = { render };
})();
