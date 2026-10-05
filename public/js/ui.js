/* 通用 UI 工具：HTML 转义、图标、Toast、发音、格式化 */
(function () {
  'use strict';

  /** HTML 转义 —— 所有插入 innerHTML 的动态文本都要过这一层 */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** SVG 图标库（stroke 风格，统一 1.9 描边） */
  const ICONS = {
    speaker: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    flame: '<path d="M12 2s4 4.5 4 8a4 4 0 0 1-8 0c0-1.5.6-2.6 1.4-3.6"/><path d="M12 22a6 6 0 0 0 6-6c0-2-1-3.6-2.2-5"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    award: '<circle cx="12" cy="8" r="6"/><path d="m8.2 13.5-1.2 8 5-3 5 3-1.2-8"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/>',
    download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 21h16"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    brain: '<path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.55A2.5 2.5 0 0 0 5 7.5a2.5 2.5 0 0 0 .5 1.5A2.5 2.5 0 0 0 5 11a2.5 2.5 0 0 0 1.2 2.1A2.5 2.5 0 0 0 7 17.5 2.5 2.5 0 0 0 9.5 20h.5a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z"/><path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.55A2.5 2.5 0 0 1 19 7.5a2.5 2.5 0 0 1-.5 1.5A2.5 2.5 0 0 1 19 11a2.5 2.5 0 0 1-1.2 2.1A2.5 2.5 0 0 1 17 17.5 2.5 2.5 0 0 1 14.5 20H14a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4"/><path d="M16 3v4"/><path d="M3 11h18"/>',
    trendingUp: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    note: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H18a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 19.5z"/><path d="M8 7.5h8"/><path d="M8 11.5h8"/><path d="M8 15.5h5"/>',
    pause: '<rect x="7" y="5" width="4" height="14" rx="1"/><rect x="13" y="5" width="4" height="14" rx="1"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
  };

  function icon(name, cls = 'ico') {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  }

  /** 星级（柯林斯 0-5） */
  function collinsStars(n) {
    if (!n) return '';
    let out = '';
    for (let i = 1; i <= 5; i++) {
      out += `<svg viewBox="0 0 24 24" fill="${i <= n ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${ICONS.star}</svg>`;
    }
    return `<span class="stars collins" title="柯林斯词典星级 ${n}/5">${out}</span>`;
  }

  const STATUS_TEXT = { new: '未学', learning: '学习中', reviewing: '复习中', mastered: '已掌握' };
  function statusChip(status, due) {
    if (due) return `<span class="chip due">待复习</span>`;
    return `<span class="chip ${status}">${STATUS_TEXT[status] || status}</span>`;
  }

  /* --------------------------- Toast --------------------------- */
  function toast(msg, kind = '') {
    const box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = (kind === 'ok' ? icon('check') : kind === 'bad' ? icon('x') : '') + esc(msg);
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 260);
    }, 2200);
  }

  /* --------------------------- 发音 --------------------------- */
  let voices = [];
  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    voices = window.speechSynthesis.getVoices() || [];
  }
  if ('speechSynthesis' in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  /**
   * 朗读。
   *
   * 两个坑：
   *  1. **不要在 speak() 前无条件 cancel()** —— Chrome/Edge 在同一个任务里
   *     先 cancel 再 speak，新的这句经常被直接丢掉（表现就是「点了没声音」）。
   *     只在确实有东西在播/排队时才取消。
   *  2. 浏览器可能以「没有用户手势」为由拦下朗读（autoplay 策略），
   *     这时会触发 onerror 且 error = 'not-allowed'。用 opts.onBlocked 把它交给调用方，
   *     由调用方在用户下一次点击时重试。
   *
   * opts.silent = true 时不弹错误提示 —— 自动发音失败不该打断学习。
   */
  function speak(text, accent = 'us', opts = {}) {
    /* 移动端用 Google TTS 作为 speechSynthesis 的替代方案 ——
       speechSynthesis 在移动端支持不完整，Google TTS 通过 <audio> 直接播放。 */
    const isMobile = window.matchMedia('(max-width: 860px)').matches
      || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (isMobile && !opts.forceNative) {
      const text2 = encodeURIComponent(String(text).slice(0, 200));
      const accentMap = { us: 'en', uk: 'en-gb', au: 'en-au' };
      const lang = accentMap[accent] || 'en';
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${text2}&tl=${lang}&client=tw-ob`;
      try {
        const audio = new Audio(url);
        audio.onerror = () => {
          if (opts.onBlocked) opts.onBlocked('network');
        };
        audio.play().catch(() => {
          if (opts.onBlocked) opts.onBlocked('not-allowed');
        });
      } catch (e) {
        if (opts.onBlocked) opts.onBlocked('exception');
      }
      return;
    }
    if (!('speechSynthesis' in window)) {
      if (!opts.silent) toast('当前浏览器不支持语音朗读', 'bad');
      if (opts.onBlocked) opts.onBlocked('unsupported');
      return;
    }
    if (!voices.length) loadVoices();
    const lang = accent === 'uk' ? 'en-GB' : 'en-US';
    const pick =
      voices.find((v) => v.lang === lang && /Google|Microsoft|natural/i.test(v.name)) ||
      voices.find((v) => v.lang === lang) ||
      voices.find((v) => v.lang && v.lang.startsWith('en'));

    try {
      const synth = window.speechSynthesis;
      if (synth.speaking || synth.pending) synth.cancel();

      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = lang;
      u.rate = 0.9;
      u.pitch = 1;
      if (pick) u.voice = pick;
      u.onerror = (e) => {
        const why = String((e && e.error) || '');
        if (opts.onBlocked && /not-allowed|NotAllowed/i.test(why)) opts.onBlocked(why);
        else if (!opts.silent && why && why !== 'interrupted' && why !== 'canceled') {
          toast(`朗读失败（${why}）`, 'bad');
        }
      };
      synth.speak(u);
    } catch (err) {
      if (!opts.silent) toast('朗读失败', 'bad');
      if (opts.onBlocked) opts.onBlocked('exception');
    }
  }

  /* --------------------------- 格式化 --------------------------- */
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function relTime(iso) {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.round(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    if (min < 1440) return `${Math.round(min / 60)} 小时前`;
    return `${Math.round(min / 1440)} 天前`;
  }

  /** 面向「未来」的时间描述，用于下次复习时间 */
  function fmtDue(iso) {
    if (!iso) return '—';
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return '现在就该复习';
    const min = Math.round(diff / 60000);
    if (min < 60) return `${min} 分钟后`;
    if (min < 1440) return `${Math.round(min / 60)} 小时后`;
    const day = Math.round(min / 1440);
    if (day <= 7) return `${day} 天后`;
    return fmtDate(iso);
  }

  function todayCn() {
    const d = new Date();
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    if (h < 23) return '晚上好';
    return '夜深了';
  }

  /** 把释义文本按 "；" 切成一条条，并解析出词性前缀 */
  function splitMeaning(meaning) {
    if (!meaning) return [];
    return String(meaning)
      .split('；')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^([a-zA-Z]{1,6}\.)\s*(.*)$/);
        return m ? { pos: m[1], text: m[2] } : { pos: '', text: line };
      });
  }

  /**
   * 列表用的精简释义：把词性标记从释义里摘掉。
   * 列表行已经单独用彩色 mono 字体展示了词性，释义里再带一遍就是重复。
   * 只识别标准词性记号，避免误伤 "U.S." 这类正常文本。
   */
  const POS_TOKENS = 'n|v|vt|vi|a|adj|adv|prep|conj|pron|num|art|int|interj|aux|abbr|pl|u|c';
  const POS_HEAD = new RegExp(`^(?:(?:${POS_TOKENS})\\.\\s*)+`, 'i');
  const POS_MID = new RegExp(`；\\s*(?:${POS_TOKENS})\\.\\s*`, 'gi');

  function meaningBrief(meaning, maxLen = 70) {
    let s = String(meaning || '').replace(POS_HEAD, '').replace(POS_MID, '；').trim();
    if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
    return s;
  }

  function debounce(fn, ms = 260) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  window.UI = {
    esc, icon, ICONS, collinsStars, STATUS_TEXT, statusChip,
    toast, speak, fmtDate, relTime, fmtDue, todayCn, greeting,
    splitMeaning, meaningBrief, debounce,
  };
})();
