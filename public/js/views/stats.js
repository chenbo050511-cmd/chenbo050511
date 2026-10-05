/* 统计 —— 学习量、正确率、热力图、记忆阶段分布 */
(function () {
  'use strict';

  const U = window.UI;

  /*
   * 阶段标签**不再在这里写死**，由 /api/stats/stages 下发（源自 src/srs.js 的 INTERVALS）。
   * 这里曾经抄了一份 10 档的老表（'5 分钟','30 分钟','12 小时',…），
   * 排期改成 6 档日粒度后没人同步，于是统计页把「1 天」显示成「5 分钟」，
   * 和翻卡页用 srs.humanInterval() 算出来的说法互相矛盾。
   */
  const STAGE_COLOR = { warn: 'var(--warn)', info: 'var(--info)', accent: 'var(--accent)', ok: 'var(--ok)' };

  let range = 30;

  async function render(el) {
    el.innerHTML = '<div id="st-root"></div>';
    await load();
  }

  function root() {
    return document.getElementById('st-root');
  }

  async function load() {
    root().innerHTML = '<div class="card"><div class="skel" style="height:16px;width:200px"></div></div>';

    const [overview, daily, heat, load_, stages, books] = await Promise.all([
      API.overview(),
      API.daily(range),
      API.heatmap(364),
      API.load(14),
      API.stages(),
      API.bookStats(),
    ]);

    const s = overview.streak;

    root().innerHTML = `
      <div class="page-head">
        <div>
          <h1>统计</h1>
          <div class="sub">数据只存在本机，用来判断节奏是不是合适</div>
        </div>
        <div class="seg" id="range-seg">
          ${[14, 30, 90].map((r) => `<button data-v="${r}" class="${r === range ? 'on' : ''}">${r} 天</button>`).join('')}
        </div>
      </div>

      <div class="grid g-4" style="margin-bottom:16px">
        ${tile('list', '词库总量', overview.word_total, '<small>词</small>', `已开始 ${overview.started}（${overview.percent}%）`)}
        ${tile('award', '已掌握', overview.mastered, '', `复习中 ${overview.reviewing} · 学习中 ${overview.learning}`)}
        ${tile('flame', '连续打卡', s.current, '<small>天</small>', `最长 ${s.best} 天 · 累计 ${overview.studyDays} 天`)}
        ${tile('trendingUp', '累计正确率', overview.accuracy, '<small>%</small>', `${overview.totalReviews} 次练习 · ${overview.minutes} 分钟`)}
      </div>

      <div class="grid g-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title">
            <h3>每日练习量（对 / 错）</h3>
            <span class="hint">区间合计 ${daily.totals.learned} 次</span>
          </div>
          ${Charts.stackedBar(
            daily.items.map((i) => ({ label: i.day.slice(5).replace('-', '/'), right: i.right, wrong: i.wrong })),
            { height: 170 }
          )}
          <div class="row" style="gap:16px;margin-top:10px;font-size:12px;color:var(--text-dim)">
            <span class="row" style="gap:6px"><i style="width:10px;height:10px;border-radius:3px;background:var(--ok);display:inline-block"></i>答对</span>
            <span class="row" style="gap:6px"><i style="width:10px;height:10px;border-radius:3px;background:var(--bad);display:inline-block"></i>答错</span>
            <span class="spacer"></span>
            <span>区间内新学 ${daily.totals.newWords} 个词</span>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <h3>新词 vs 复习量</h3>
            <span class="hint">看节奏是否失衡</span>
          </div>
          ${Charts.barChart(
            daily.items.map((i) => ({
              label: i.day.slice(5).replace('-', '/'),
              value: i.learned,
              color: i.newWords > 0 ? 'var(--accent)' : 'var(--info)',
            })),
            { height: 170 }
          )}
          <div class="row" style="gap:16px;margin-top:10px;font-size:12px;color:var(--text-dim)">
            <span class="row" style="gap:6px"><i style="width:10px;height:10px;border-radius:3px;background:var(--accent);display:inline-block"></i>当天有新词</span>
            <span class="row" style="gap:6px"><i style="width:10px;height:10px;border-radius:3px;background:var(--info);display:inline-block"></i>纯复习</span>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">
          <h3>学习日历</h3>
          <span class="hint">最近 52 周 · 每天练习次数</span>
        </div>
        ${Charts.heatmap(heat.items)}
        <div class="row" style="margin-top:10px">
          <span class="spacer"></span>
          <div class="legend">
            <span>少</span>
            <div class="heat-cell" style="background:var(--track)"></div>
            <div class="heat-cell" style="background:color-mix(in srgb, var(--accent) 30%, transparent)"></div>
            <div class="heat-cell" style="background:color-mix(in srgb, var(--accent) 55%, transparent)"></div>
            <div class="heat-cell" style="background:color-mix(in srgb, var(--accent) 78%, transparent)"></div>
            <div class="heat-cell" style="background:var(--accent)"></div>
            <span>多</span>
          </div>
        </div>
      </div>

      <div class="grid g-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title">
            <h3>记忆阶段分布</h3>
            <span class="hint">阶段越高，复习间隔越长</span>
          </div>
          <div class="stage-rows">
            ${Charts.stageBars(
              stages.items.map((x) => ({ label: x.label, count: x.count })),
              { colorFor: (it) => STAGE_COLOR[stages.colorOf[stages.labels.indexOf(it.label)]] || 'var(--accent)' }
            )}
          </div>
          <p style="font-size:12px;color:var(--text-mute);margin-top:12px">
            集中在左侧说明大量词还在初学；右侧柱子变粗，代表真正记住的词在变多。
          </p>
        </div>

        <div class="card">
          <div class="card-title">
            <h3>未来 14 天复习负载</h3>
            <span class="hint">${load_.overdue ? `已逾期 <b style="color:var(--bad)">${load_.overdue}</b> 个` : '暂无逾期'}</span>
          </div>
          ${Charts.barChart(
            load_.items.map((i) => ({ label: i.day.slice(5).replace('-', '/'), value: i.due })),
            { height: 190 }
          )}
          <p style="font-size:12px;color:var(--text-mute);margin-top:10px">
            如果某天柱子特别高，可以提前把每日复习上限调低一些，或者当天分两次做完。
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><h3>各词库完成度</h3></div>
        ${books.map((b) => `
          <div style="margin-bottom:16px">
            <div class="row" style="margin-bottom:6px">
              <b style="font-size:13.5px">${U.esc(b.short_name)}</b>
              <span class="spacer"></span>
              <span style="font-size:12.5px;color:var(--text-dim);font-variant-numeric:tabular-nums">
                ${b.started} / ${b.total} 已学 · 掌握 ${b.mastered} · 待复习 ${b.due}
              </span>
            </div>
            <div class="bar"><i style="width:${b.total ? Math.round((b.started / b.total) * 100) : 0}%;background:${U.esc(b.accent)}"></i></div>
          </div>`).join('')}
      </div>
    `;

    document.getElementById('range-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      range = Number(b.dataset.v);
      load();
    });
  }

  function tile(icon, k, v, suffix = '', note = '') {
    return `<div class="card tile">
      <span class="k">${U.icon(icon)} ${k}</span>
      <span class="v">${v}${suffix}</span>
      <span style="font-size:11.5px;color:var(--text-mute)">${note}</span>
    </div>`;
  }

  window.Views = window.Views || {};
  window.Views.stats = { render };
})();
