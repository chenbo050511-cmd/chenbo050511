/* API 客户端：统一请求、错误提示 */
(function () {
  'use strict';

  async function request(path, options = {}) {
    const opt = { headers: {}, ...options };
    if (opt.body !== undefined && typeof opt.body !== 'string') {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(opt.body);
    }

    let res;
    try {
      res = await fetch('/api' + path, opt);
    } catch (err) {
      throw new Error('无法连接到本地服务，请确认服务仍在运行');
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error('服务返回了无法解析的内容');
    }

    if (!res.ok) {
      throw new Error((data && data.error) || `请求失败（${res.status}）`);
    }
    return data;
  }

  function qs(params) {
    const p = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      p.set(k, v);
    });
    const s = p.toString();
    return s ? '?' + s : '';
  }

  window.API = {
    health: () => request('/health'),

    books: () => request('/books'),
    units: (code) => request(`/books/${code}/units`),
    letters: (code) => request(`/books/${code}/letters`),
    posList: (code) => request(`/books/${code}/pos`),

    words: (params) => request('/words' + qs(params)),
    word: (id) => request('/words/' + id),
    randomWords: (book, count) => request('/words/random/pick' + qs({ book, count })),
    favorite: (id, favorite) => request(`/words/${id}/favorite`, { method: 'POST', body: { favorite } }),
    /** 做真题时点词查义：会做词形回落（conditions → condition） */
    lookupWord: (word) => request('/words/lookup' + qs({ word })),
    /** 手动加入 / 移出错题本（不传 marked 就是切换） */
    markWord: (id, marked) => request(`/words/${id}/mark`, { method: 'POST', body: { marked } }),
    /** 助记笔记（传空字符串即删除） */
    saveNote: (id, note) => request(`/words/${id}/note`, { method: 'POST', body: { note } }),
    /** 顽固词：暂缓 / 恢复 */
    suspendWord: (id, suspended) => request(`/words/${id}/suspend`, { method: 'POST', body: { suspended } }),
    resetWord: (id) => request(`/words/${id}/reset`, { method: 'POST' }),

    /** 学习计划：mode='new' 学新词 | 'review' 复习（两者不混合） */
    plan: (book, { mode = 'new', ignoreLimit = false } = {}) =>
      request('/study/plan' + qs({ book, mode, ignoreLimit: ignoreLimit ? 1 : '' })),
    /**
     * 卡片作答。phase 决定这一笔是什么：
     *   first  第一次作答（只记流水，等过关再排期）
     *   repeat 本轮重复的作答（只留流水）
     *   pass   本轮过关（这时候才定下次复习时间）
     */
    answer: (wordId, rating, bookCode, phase, firstRating) =>
      request('/study/answer', { method: 'POST', body: { wordId, rating, bookCode, phase, firstRating } }),
    today: (book) => request('/study/today' + qs({ book })),
    studyTime: (seconds) => request('/study/time', { method: 'POST', body: { seconds } }),

    quiz: (params) => request('/quiz' + qs(params)),
    /** 判分在服务端：只提交「选了哪个 key」（chosen），对错由服务端判定 */
    submitQuiz: (bookCode, answers, sessionId) =>
      request('/quiz/submit', { method: 'POST', body: { bookCode, answers, sessionId } }),
    mistakes: (book, limit) => request('/quiz/mistakes' + qs({ book, limit })),
    /** 顽固词（leech）清单：累计错误次数超阈值的词 */
    leeches: (book, limit) => request('/quiz/leeches' + qs({ book, limit })),
    clearMistake: (wordId) => request('/quiz/mistakes/clear', { method: 'POST', body: { wordId } }),

    examOverview: () => request('/exam/overview'),
    examSets: (params) => request('/exam/sets' + qs(params)),
    examSet: (id) => request('/exam/sets/' + id),
    examSubmit: (setId, answers, durationMs) =>
      request('/exam/submit', { method: 'POST', body: { setId, answers, durationMs } }),
    examRecords: (page) => request('/exam/records' + qs({ page })),
    examRecord: (id) => request('/exam/records/' + id),
    examWrong: (params) => request('/exam/wrong' + qs(params)),
    examReset: (setId) => request('/exam/records/reset', { method: 'POST', body: { setId } }),

    overview: () => request('/stats/overview'),
    daily: (days) => request('/stats/daily' + qs({ days })),
    heatmap: (days) => request('/stats/heatmap' + qs({ days })),
    load: (days) => request('/stats/load' + qs({ days })),
    stages: () => request('/stats/stages'),
    bookStats: () => request('/stats/books'),

    settings: () => request('/settings'),
    saveSettings: (body) => request('/settings', { method: 'PUT', body }),
    reset: (scope) => request('/settings/reset', { method: 'POST', body: { scope } }),
  };
})();
