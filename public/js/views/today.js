/* 今日 —— 仪表盘 */
(function () {
  'use strict';

  const U = window.UI;

  async function render(el) {
    const code = window.App.state.book ? window.App.state.book.code : '';
    const [today, load, daily, stages] = await Promise.all([
      API.today(code),
      API.load(7),
      API.daily(14),
      API.stages(),
    ]);

    window.App.state.today = today;
    const book = window.App.state.book = today.book;
    const s = today.settings;
    const g = today.global;
    const streak = today.streak;

    const goalNew = today.goal.newTarget ? Math.round((today.goal.new / today.goal.newTarget) * 100) : 100;
    const goalRev = today.goal.reviewTarget ? Math.round((today.goal.review / today.goal.reviewTarget) * 100) : 100;
    const overallDone = Math.round((Math.min(100, goalNew) + Math.min(100, goalRev)) / 2);

    const queueEmpty = today.pools.dueTotal === 0 && today.pools.newAvail === 0;
    /*
     * 复习也**不设硬上限**：daily_review 只是今日目标。
     * 之前取 min(到期数, 额度剩余)，额度用完后按钮会显示 0 ——
     * 但侧边栏徽标还在统计到期的词，于是「明明复习完了还显示 99+」。
     */
    const willReview = today.pools.dueTotal;
    const reviewGoalDone = today.counters.dailyReview > 0
      && today.counters.reviewed >= today.counters.dailyReview;
    /*
     * 新词**不设硬上限**：daily_new 只是今日目标，达成了也能继续学。
     * 所以这里直接用「词库里还剩多少没学过的」。
     */
    const willLearn = today.pools.newAvail;
    const goalLeft = Math.max(0, today.counters.dailyNew - today.counters.newLearned);
    const newGoalDone = goalLeft === 0 && today.counters.dailyNew > 0;

    el.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${U.greeting()}</h1>
          <div class="sub">${U.todayCn()} · 今天也来认识几个新词</div>
        </div>
        <div class="row wrap">
          <select class="select" id="book-switch" style="min-width:180px">
            ${window.App.state.books.map((b) => `
              <option value="${b.code}" ${b.code === book.code ? 'selected' : ''}>
                ${U.esc(b.short_name)} · ${b.total} 词
              </option>`).join('')}
          </select>
          <button class="btn" id="theme-btn" title="切换白色 / 深色主题">
            <span class="only-dark">${U.icon('sun')} 白色</span>
            <span class="only-light">${U.icon('moon')} 深色</span>
          </button>
        </div>
      </div>

      <div class="grid g-hero" style="margin-bottom:16px">
        <div class="card pad-lg">
          <div class="card-title">
            <h3>今日目标</h3>
            <span class="chip ${streak.current > 0 ? 'mastered' : ''}">
              ${U.icon('flame', 'ico')} 连续 ${streak.current} 天
            </span>
          </div>

          <div class="goal-row">
            <div class="ring">
              ${Charts.ring(overallDone, { color: overallDone >= 100 ? 'var(--ok)' : 'var(--accent)' })}
              <div class="val">${overallDone}%<small>完成度</small></div>
            </div>

            <div class="goal-bars">
              <div>
                <div class="row" style="margin-bottom:6px">
                  <span style="font-size:13.5px;font-weight:600">新词</span>
                  <span class="spacer"></span>
                  <span style="font-size:13px;color:var(--text-dim);font-variant-numeric:tabular-nums">
                    <b style="color:var(--text)">${today.goal.new}</b> / ${today.goal.newTarget}
                  </span>
                </div>
                <div class="bar"><i style="width:${Math.min(100, goalNew)}%"></i></div>
              </div>

              <div>
                <div class="row" style="margin-bottom:6px">
                  <span style="font-size:13.5px;font-weight:600">复习</span>
                  <span class="spacer"></span>
                  <span style="font-size:13px;color:var(--text-dim);font-variant-numeric:tabular-nums">
                    <b style="color:var(--text)">${today.goal.review}</b> / ${today.goal.reviewTarget}
                  </span>
                </div>
                <div class="bar ok"><i style="width:${Math.min(100, goalRev)}%"></i></div>
              </div>
            </div>
          </div>

          <div class="row" style="margin-top:20px;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary btn-lg" id="start-review" ${willReview ? '' : 'disabled'}>
              ${U.icon('zap')}
              ${willReview
                ? `开始复习 · ${willReview} 个到期${reviewGoalDone ? '（今日已达标，可继续）' : ''}`
                : '今天没有到期的词'}
            </button>
            <button class="btn btn-lg" id="start-new" ${willLearn ? '' : 'disabled'}>
              ${U.icon('book')}
              ${willLearn
                ? (newGoalDone ? `继续学新词 · 今日已达标 ${today.counters.newLearned} 个` : `学新词 · 今日还剩 ${goalLeft} 个达标`)
                : '这个词库的新词都学完了'}
            </button>
            <button class="btn btn-lg" id="start-quiz">${U.icon('check')} 做一组测试</button>
          </div>

          ${queueEmpty ? `<p style="margin-top:12px;font-size:12.5px;color:var(--text-mute)">
            当前词库已全部学过一轮，可以换个词库，或去「设置」把每日新词量调大。</p>` : ''}
        </div>

        <div class="card pad-lg">
          <div class="card-title">
            <h3>当前词库</h3>
            <span class="chip" style="color:${U.esc(book.accent)};border-color:${U.esc(book.accent)}44;background:transparent">
              ${U.esc(book.short_name)}
            </span>
          </div>
          <div style="font-size:14.5px;font-weight:600;margin-bottom:2px">${U.esc(book.name)}</div>
          <p style="font-size:12.5px;color:var(--text-mute);margin-bottom:14px">${U.esc(book.description || '')}</p>

          <div class="row" style="margin-bottom:6px">
            <span style="font-size:12.5px;color:var(--text-dim)">学习进度</span>
            <span class="spacer"></span>
            <span style="font-size:12.5px;color:var(--text-dim);font-variant-numeric:tabular-nums">
              ${book.started} / ${book.total}
            </span>
          </div>
          <div class="bar"><i style="width:${book.percent}%;background:${U.esc(book.accent)}"></i></div>

          <div class="grid g-2" style="margin-top:18px;gap:12px">
            <div class="tile">
              <span class="k">待复习</span>
              <span class="v" style="color:${today.pools.dueTotal ? 'var(--bad)' : 'inherit'}">${today.pools.dueTotal}</span>
            </div>
            <div class="tile">
              <span class="k">未学新词</span>
              <span class="v">${today.pools.newAvail}</span>
            </div>
            <div class="tile">
              <span class="k">已掌握</span>
              <span class="v" style="color:var(--ok)">${book.mastered}</span>
            </div>
            <div class="tile">
              <span class="k">单元数</span>
              <span class="v">${book.unit_count}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="grid g-4" style="margin-bottom:16px">
        ${tile('target', '累计学过', g.started, `<small>/ ${g.total}</small>`, `覆盖 ${g.percent}%`)}
        ${tile('award', '已掌握', g.mastered, '', `复习中 ${g.reviewing} · 学习中 ${g.learning}`)}
        ${tile('flame', '连续打卡', streak.current, '<small>天</small>', `最长 ${streak.best} 天 · 累计 ${g.studyDays} 天`)}
        ${tile('trendingUp', '累计正确率', g.accuracy, '<small>%</small>',
          g.suspendedWords ? `已暂缓 ${g.suspendedWords} 个顽固词` : `共练习 ${g.totalReviews} 次`)}
      </div>

      <div class="grid g-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title">
            <h3>未来 7 天复习负载</h3>
            <span class="hint">${load.overdue ? `已逾期 <b style="color:var(--bad)">${load.overdue}</b> 个` : '暂无逾期'}</span>
          </div>
          ${Charts.barChart(
            load.items.map((i) => ({ label: i.day.slice(5).replace('-', '/'), value: i.due })),
            { height: 150 }
          )}
          <p style="font-size:12px;color:var(--text-mute);margin-top:8px">
            按艾宾浩斯曲线预测的到期量 —— 提前知道哪几天会堆任务，就不会被压垮。
          </p>
        </div>

        <div class="card">
          <div class="card-title">
            <h3>近 14 天学习量</h3>
            <span class="hint">合计 ${daily.totals.learned} 次 · 新词 ${daily.totals.newWords} 个</span>
          </div>
          ${Charts.barChart(
            daily.items.map((i) => ({ label: i.day.slice(5).replace('-', '/'), value: i.learned })),
            { height: 150 }
          )}
          <p style="font-size:12px;color:var(--text-mute);margin-top:8px">
            当前记忆阶段分布：${stageTip(stages)}
          </p>
        </div>
      </div>
    `;

    document.getElementById('book-switch').addEventListener('change', async (e) => {
      await window.App.setBook(e.target.value);
      render(el);
    });
    document.getElementById('theme-btn').addEventListener('click', () => {
      const next = window.App.toggleTheme();
      U.toast(next === 'light' ? '已切换为白色主题' : '已切换为深色主题', 'ok');
    });
    document.getElementById('start-review').addEventListener('click', () => window.App.go('#/review'));
    document.getElementById('start-new').addEventListener('click', () => window.App.go('#/study'));
    document.getElementById('start-quiz').addEventListener('click', () => window.App.go('#/quiz'));
  }

  function tile(icon, k, v, suffix = '', note = '') {
    return `<div class="card tile">
      <span class="k">${U.icon(icon)} ${k}</span>
      <span class="v">${v}${suffix}</span>
      <span style="font-size:11.5px;color:var(--text-mute)">${note}</span>
    </div>`;
  }

  function stageTip(stages) {
    const s = stages.status;
    return `未学 ${s.new} · 学习中 ${s.learning} · 复习中 ${s.reviewing} · 已掌握 ${s.mastered}`;
  }

  window.Views = window.Views || {};
  window.Views.today = { render };
})();
