/* 设置 —— 学习参数、外观、数据管理 */
(function () {
  'use strict';

  const U = window.UI;

  async function render(el) {
    el.innerHTML = '<div id="set-root"></div>';
    await load();
    window.App._cleanup = () => document.removeEventListener('wm-theme-change', onThemeChange);
  }

  /** 主题在别处被切换时，把这里的分段按钮同步过来 */
  function onThemeChange(e) {
    const t = e.detail.theme;
    document.querySelectorAll('#s-theme button').forEach((x) => {
      x.classList.toggle('on', x.dataset.v === t);
    });
  }

  function root() {
    return document.getElementById('set-root');
  }

  async function load() {
    const [data, overview] = await Promise.all([API.settings(), API.overview()]);
    const s = data.settings;
    window.App.state.settings = s;
    window.App.state.meta = data.meta;

    root().innerHTML = `
      <div class="page-head">
        <div>
          <h1>设置</h1>
          <div class="sub">修改后立即生效，不需要重启服务</div>
        </div>
      </div>

      <div class="grid g-2" style="margin-bottom:16px">
        <div class="card pad-lg">
          <div class="card-title"><h3>学习计划</h3></div>

          ${row('每日新词量', '每天最多引入多少个新词。设 0 表示只复习不学新词。',
            `<input class="input" type="number" min="0" max="500" id="s-daily-new" value="${U.esc(s.daily_new)}">`)}
          ${row('每日复习上限', '单日复习的软性上限，防止某天任务堆积过多。',
            `<input class="input" type="number" min="0" max="2000" id="s-daily-review" value="${U.esc(s.daily_review)}">`)}
          ${row('新词顺序', '按词频先学高频词，还是按字母顺序稳扎稳打。',
            `<select class="select" id="s-order">
              <option value="freq" ${s.new_order === 'freq' ? 'selected' : ''}>高频优先</option>
              <option value="alpha" ${s.new_order === 'alpha' ? 'selected' : ''}>字母顺序</option>
            </select>`)}
          ${row('默认词库', '打开应用时默认使用的词库。',
            `<select class="select" id="s-book">
              ${window.App.state.books.map((b) => `<option value="${b.code}" ${b.code === s.active_book ? 'selected' : ''}>${U.esc(b.short_name)}</option>`).join('')}
            </select>`)}
          ${row('顽固词阈值', '「测试答错 + 翻卡不认识」累计达到几次，就在错题本里标为顽固词，建议换个记法。',
            `<input class="input" type="number" min="1" max="1000" id="s-leech" value="${U.esc(s.leech_threshold)}">`)}
        </div>

        <div class="card pad-lg">
          <div class="card-title"><h3>发音与外观</h3></div>

          ${row('发音口音', '调用系统语音合成朗读，离线可用。点「测试发音」确认浏览器能出声。',
            `<div class="row" style="gap:8px">
              <select class="select" id="s-accent">
                <option value="us" ${s.accent === 'us' ? 'selected' : ''}>美音 en-US</option>
                <option value="uk" ${s.accent === 'uk' ? 'selected' : ''}>英音 en-GB</option>
              </select>
              <button class="btn btn-sm" id="s-test-speak">测试发音</button>
            </div>`)}
          ${row('卡片出现时自动发音', '每个单词一出现就自动朗读，不用再去点喇叭。重复出现的错词也会再读一遍。个别浏览器需要你先手动点一次喇叭授权。',
            `<label class="switch"><input type="checkbox" id="s-auto-speak" ${s.auto_pronounce === '1' ? 'checked' : ''}><span class="track"></span></label>`)}
          ${row('显示音标', '在卡片和列表里展示 IPA 音标。',
            `<label class="switch"><input type="checkbox" id="s-phonetic" ${s.show_phonetic === '1' ? 'checked' : ''}><span class="track"></span></label>`)}
          ${row('答对自动下一题', '测试中答对后自动跳到下一题，答错则停留久一点。',
            `<label class="switch"><input type="checkbox" id="s-auto-next" ${s.auto_next === '1' ? 'checked' : ''}><span class="track"></span></label>`)}
          ${row('界面主题', '白色主题白底黑字，适合白天；深色主题夜里护眼。任何页面左侧都能一键切换，设置会记在本机。',
            `<div class="seg" id="s-theme">
              <button data-v="light" class="${s.theme === 'light' ? 'on' : ''}">白色</button>
              <button data-v="dark" class="${s.theme === 'dark' ? 'on' : ''}">深色</button>
            </div>`)}
        </div>
      </div>

      <div class="card pad-lg" style="margin-bottom:16px">
        <div class="card-title">
          <h3>测试默认值</h3>
          <span class="hint">只影响「测试」页的初始选项</span>
        </div>
        ${row('默认题量', '',
          `<div class="seg" id="s-quiz-count">
            ${[10, 20, 30, 50].map((n) => `<button data-v="${n}" class="${String(n) === s.quiz_count ? 'on' : ''}">${n} 题</button>`).join('')}
          </div>`)}
        ${row('默认题型', '',
          `<div class="seg" id="s-quiz-type">
            <button data-v="mix" class="${s.quiz_type === 'mix' ? 'on' : ''}">混合</button>
            <button data-v="en2cn" class="${s.quiz_type === 'en2cn' ? 'on' : ''}">英 → 中</button>
            <button data-v="cn2en" class="${s.quiz_type === 'cn2en' ? 'on' : ''}">中 → 英</button>
          </div>`)}
      </div>

      <div class="card pad-lg" style="margin-bottom:16px">
        <div class="card-title">
          <h3>数据与备份</h3>
          <span class="hint">数据全部保存在本机 SQLite 文件里</span>
        </div>

        ${row('导出学习进度', '把每个词的状态、记忆阶段、对错次数导成 CSV，可用 Excel 打开。',
          `<a class="btn" href="/api/settings/export" download>${U.icon('download')} 导出 CSV</a>`)}
        ${row('导出练习流水', '每一次翻卡和答题的完整记录。',
          `<a class="btn" href="/api/settings/export/logs" download>${U.icon('download')} 导出 CSV</a>`)}
        ${row('数据库位置', U.esc(data.database || 'data/wordmaster.db'), `<span class="chip">${(overview.word_total)} 词</span>`)}
        ${row('词库来源', U.esc(data.meta.dict_source || 'ECDICT') + (data.meta.built_at ? ` · 构建于 ${String(data.meta.built_at).slice(0, 10)}` : ''), `<span class="chip">${U.esc((data.meta.dict_checksum || '').slice(0, 12))}</span>`)}
      </div>

      <div class="card pad-lg danger-zone">
        <div class="card-title">
          <h3 style="color:var(--bad)">危险操作</h3>
          <span class="hint">不可撤销，操作前请先导出备份</span>
        </div>

        ${row('清空学习进度', '删除所有词的记忆阶段、复习排期、收藏和打卡记录。词库本身保留。',
          `<button class="btn btn-bad" data-reset="progress">${U.icon('trash')} 清空进度</button>`)}
        ${row('清空练习流水', '只删掉统计用的历史记录，学习进度保留（正确率等图表会归零）。',
          `<button class="btn" data-reset="logs">${U.icon('trash')} 清空流水</button>`)}
        ${row('恢复出厂设置', '进度、流水、设置全部重置为默认值。',
          `<button class="btn btn-bad" data-reset="all">${U.icon('refresh')} 全部重置</button>`)}
      </div>

      <p style="font-size:12px;color:var(--text-mute);text-align:center;margin-top:22px">
        WordMaster v1.0.0 · Node ${U.esc((data.meta.node || '') || '')} · 本地运行，无网络请求
      </p>
    `;

    bind(s);
  }

  function row(title, desc, ctrl) {
    return `<div class="setting-row">
      <div class="s-info">
        <b>${title}</b>
        ${desc ? `<span>${desc}</span>` : ''}
      </div>
      <div class="s-ctrl">${ctrl}</div>
    </div>`;
  }

  function bind(s) {
    const save = async (patch) => {
      try {
        await API.saveSettings(patch);
        Object.assign(window.App.state.settings, patch);
        U.toast('已保存', 'ok');
      } catch (err) {
        U.toast(err.message, 'bad');
      }
    };

    document.getElementById('s-daily-new').addEventListener('change', (e) => save({ daily_new: e.target.value }));
    document.getElementById('s-daily-review').addEventListener('change', (e) => save({ daily_review: e.target.value }));
    document.getElementById('s-leech').addEventListener('change', (e) => save({ leech_threshold: e.target.value }));
    document.getElementById('s-order').addEventListener('change', (e) => save({ new_order: e.target.value }));
    document.getElementById('s-accent').addEventListener('change', (e) => save({ accent: e.target.value }));

    // 测试发音：不属于任何设置项，只是让用户当场确认「浏览器能不能出声」。
    // 读不出来时会弹具体原因（比如 not-allowed = 浏览器把自动播放拦了）。
    document.getElementById('s-test-speak').addEventListener('click', () => {
      const accent = document.getElementById('s-accent').value;
      U.speak('vocabulary', accent);
    });

    document.getElementById('s-book').addEventListener('change', async (e) => {
      await window.App.setBook(e.target.value);
      U.toast('已切换默认词库', 'ok');
    });

    const sw = (id, key) => {
      document.getElementById(id).addEventListener('change', (e) => save({ [key]: e.target.checked ? '1' : '0' }));
    };
    sw('s-auto-speak', 'auto_pronounce');
    sw('s-phonetic', 'show_phonetic');
    sw('s-auto-next', 'auto_next');

    document.getElementById('s-theme').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      document.querySelectorAll('#s-theme button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      window.App.applyTheme(b.dataset.v);
      save({ theme: b.dataset.v });
    });

    // 侧边栏的主题按钮也能切，切完把这里的分段按钮同步过来
    // （load() 会被重复调用，所以先摘再挂，避免监听器越堆越多）
    document.removeEventListener('wm-theme-change', onThemeChange);
    document.addEventListener('wm-theme-change', onThemeChange);

    const segBind = (id, key) => {
      const box = document.getElementById(id);
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        box.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        save({ [key]: b.dataset.v });
      });
    };
    segBind('s-quiz-count', 'quiz_count');
    segBind('s-quiz-type', 'quiz_type');

    root().querySelectorAll('[data-reset]').forEach((b) => {
      b.addEventListener('click', () => confirmReset(b.dataset.reset));
    });
  }

  function confirmReset(scope) {
    const text = {
      progress: '确定要清空全部学习进度吗？所有词的记忆阶段、复习排期、收藏和打卡都会消失，且无法撤销。',
      logs: '确定要清空练习流水吗？统计图表和正确率会归零，但学习进度保留。',
      all: '确定要恢复出厂设置吗？进度、流水、设置都会重置，且无法撤销。',
    }[scope];

    // 用两层确认，避免误点
    if (!window.confirm(text)) return;
    if (scope !== 'logs' && !window.confirm('最后确认一次：这个操作不可撤销，要继续吗？')) return;

    API.reset(scope)
      .then(async () => {
        U.toast('已重置', 'ok');
        await window.App.refreshBadges();
        load();
      })
      .catch((err) => U.toast(err.message, 'bad'));
  }

  window.Views = window.Views || {};
  window.Views.settings = { render };
})();
