/* 应用外壳：路由、全局状态、导航徽标、主题 */
(function () {
  'use strict';

  const Views = (window.Views = window.Views || {});

  const App = {
    state: {
      books: [],
      book: null,          // 当前词库对象
      settings: {},
      meta: {},
      today: null,
      loading: true,
    },
    view: null,
    _cleanup: null,
    _sessionStart: Date.now(),
  };

  /* ------------------------------ 视图容器 ------------------------------ */

  function container() {
    return document.getElementById('view');
  }

  /* ------------------------------ 路由 ------------------------------ */

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    if (!raw) return { name: 'today', params: {} };
    const [name, query] = raw.split('?');
    return { name: name || 'today', params: Object.fromEntries(new URLSearchParams(query || '')) };
  }

  async function route() {
    const { name, params } = parseHash();
    if (!Views[name]) {
      location.hash = '#/today';
      return;
    }

    // 上一个视图的清理（停掉计时器 / 键盘监听 / 音频）
    if (typeof App._cleanup === 'function') {
      try { App._cleanup(); } catch { /* ignore */ }
      App._cleanup = null;
    }

    App.view = name;
    document.querySelectorAll('.nav-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === name);
    });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

    const el = container();
    el.innerHTML = `<div class="card pad-lg"><div class="skel" style="height:22px;width:180px;margin-bottom:14px"></div>
      <div class="skel" style="height:14px;width:60%;margin-bottom:8px"></div>
      <div class="skel" style="height:14px;width:40%"></div></div>`;

    try {
      await Views[name].render(el, params);
    } catch (err) {
      console.error(err);
      el.innerHTML = `<div class="card pad-lg">
        <h3 style="margin-bottom:6px">页面加载失败</h3>
        <p style="color:var(--text-dim);font-size:13.5px">${window.UI.esc(err.message)}</p>
        <button class="btn btn-primary" style="margin-top:14px" onclick="location.reload()">重新加载</button>
      </div>`;
    }
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  /* ------------------------------ 全局数据 ------------------------------ */

  async function loadBooks() {
    const books = await API.books();
    App.state.books = books;
    const saved = App.state.settings.active_book;
    App.state.book = books.find((b) => b.code === saved) || books[0] || null;
    return books;
  }

  async function loadSettings() {
    const data = await API.settings();
    App.state.settings = data.settings;
    App.state.meta = data.meta;
    // 服务端设置为准；首屏不加过渡动画（内联脚本已经先定过一次主题了）
    applyTheme(data.settings.theme, { animate: false });
    return data.settings;
  }

  const THEME_KEY = 'wm-theme';

  /**
   * 应用主题。
   * - 写进 localStorage，让下次刷新时 <head> 里的内联脚本能立刻定下主题，不闪白/闪黑
   * - 只在「真正发生变化」时加过渡类，避免首次加载时整页颜色从默认值渐变过来
   */
  function applyTheme(theme, { animate = true } = {}) {
    const t = theme === 'light' ? 'light' : 'dark';
    const root = document.documentElement;

    if (animate && root.dataset.theme && root.dataset.theme !== t) {
      root.classList.add('theme-anim');
      clearTimeout(applyTheme._timer);
      applyTheme._timer = setTimeout(() => root.classList.remove('theme-anim'), 340);
    }

    root.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* 无痕模式忽略 */ }

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0b0d12' : '#f6f7fa');

    // 通知页面内其他和主题相关的控件（比如设置页的分段按钮）同步状态
    document.dispatchEvent(new CustomEvent('wm-theme-change', { detail: { theme: t } }));
  }

  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    App.state.settings.theme = next;
    API.saveSettings({ theme: next }).catch(() => { /* 静默：本地已经切了 */ });
    return next;
  }

  async function setBook(code) {
    App.state.book = App.state.books.find((b) => b.code === code) || App.state.book;
    App.state.settings.active_book = code;
    await API.saveSettings({ active_book: code }).catch(() => { /* 静默 */ });
    await refreshBadges();
  }

  /** 侧边栏徽标：待复习 / 错题 */
  async function refreshBadges() {
    try {
      const book = App.state.book ? App.state.book.code : '';
      const t = await API.today(book);
      App.state.today = t;
      App.state.book = t.book || App.state.book;

      const dueEl = document.getElementById('nav-badge-due');
      if (dueEl) {
        dueEl.textContent = t.pools.dueTotal > 99 ? '99+' : t.pools.dueTotal;
        dueEl.classList.toggle('zero', !t.pools.dueTotal);
      }
      const wrongEl = document.getElementById('nav-badge-wrong');
      if (wrongEl) {
        const w = t.global.wrongWords || 0;
        wrongEl.textContent = w > 99 ? '99+' : w;
        wrongEl.classList.toggle('zero', !w);
      }
      // 同步徽章到移动端
      if (window.Mobile) window.Mobile.syncBadges();
      const foot = document.getElementById('foot-stat');
      if (foot) {
        foot.textContent = `${t.global.started} / ${t.global.total} 词已开始学习`;
      }
      return t;
    } catch {
      return null;
    }
  }

  /* ------------------------------ 启动 ------------------------------ */

  async function boot() {
    document.getElementById('nav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (!btn || !btn.dataset.view) return;
      go('#/' + btn.dataset.view);
    });

    window.addEventListener('hashchange', route);

    try {
      await loadSettings();
      await loadBooks();
      await refreshBadges();
    } catch (err) {
      container().innerHTML = `<div class="card pad-lg">
        <h3 style="margin-bottom:6px">连接本地服务失败</h3>
        <p style="color:var(--text-dim);font-size:13.5px">${window.UI.esc(err.message)}</p>
        <p style="color:var(--text-mute);font-size:13px;margin-top:8px">请确认 start.bat 窗口仍在运行，然后刷新页面。</p>
      </div>`;
      return;
    }

    App.state.loading = false;
    await route();

    // 每分钟刷新一次徽标，让到期的词及时冒出来
    setInterval(refreshBadges, 60000);

    // 页面隐藏时上报学习时长
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushTime();
    });
    window.addEventListener('beforeunload', flushTime);
  }

  let lastFlush = Date.now();
  function flushTime() {
    const now = Date.now();
    const seconds = Math.round((now - lastFlush) / 1000);
    lastFlush = now;
    if (seconds >= 20 && seconds < 36000) {
      API.studyTime(seconds).catch(() => { /* 静默 */ });
    }
  }

  window.App = Object.assign(App, {
    boot, route, go, setBook, refreshBadges, applyTheme, toggleTheme, currentTheme, flushTime,
    render: (html) => { container().innerHTML = html; },
    el: container,
  });

  document.addEventListener('DOMContentLoaded', boot);
})();
