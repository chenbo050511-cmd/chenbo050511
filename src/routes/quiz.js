'use strict';

/** 选择题测试：服务端出题 + 判分落库 */

const express = require('express');
const db = require('../db');
const srs = require('../srs');
const { wrap, int, saveProgress, logStudy, getProgress, isMistake } = require('../util');

const router = express.Router();

const OPTION_FIELDS = { meaning: 'w.meaning', spelling: 'w.spelling' };

/* ------------------------------------------------------------------ */
/* 判分状态（内存）                                                     */
/* ------------------------------------------------------------------ */
/*
 * 为什么判分必须在服务端做：
 * 出题时答案随 options 一起发给前端，如果提交时又采信前端传来的
 * `correct` 布尔值，那就等于「前端说对就是对」。实测过：
 *   POST /api/quiz/submit {"wordId":1,"correct":true}
 * 一个没提供任何作答内容的请求，就能把 stage 从 3 推到 5、标成 mastered、
 * 并把 due_at 推到 60 天后 —— 整条艾宾浩斯排期都是基于作答质量算的，
 * 输入不可信等于排期不可信。
 *
 * 所以：出题时把「正确答案的选项 key」留在服务端（这张表），
 * 提交时只收前端选了哪个 key，由服务端比对。
 *
 * 用内存而不是建表，是因为这份状态**本来就是临时的**：
 * 丢了最坏结果是「这次提交被判为无会话」，用户重新出一组题即可，
 * 不会损坏任何学习数据（真正落库的只有服务端自己算出来的判定）。
 * 也不想为每次提交都写一次磁盘 —— 本地单用户应用没必要。
 */
const QUIZ_TTL_MS = 2 * 60 * 60 * 1000;   // 一组题 2 小时内有效
const QUIZ_MAX_SESSIONS = 40;             // 上限，防止长期运行后无界增长
const SUBMIT_WINDOW_MS = 10 * 60 * 1000;  // 同一组的重复提交窗口
const SUBMIT_MAX = 5;                     // 窗口内最多交几次（正常只会交 1 次）

/** sessionId -> { bookId, wordIds: number[], keys: string[], issuedAt, submits: number[] } */
const sessions = new Map();

function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.issuedAt > QUIZ_TTL_MS) sessions.delete(id);
  }
  // 还是太多就按最旧的删
  while (sessions.size > QUIZ_MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
}

let seq = 0;
/** 选项 key：只用来标记「前端选了哪一个」，不承担安全职责（校验在服务端比对） */
function makeKey() {
  seq += 1;
  return `k${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 取干扰项：优先同词性、长度相近的词，保证选项「以假乱真」 */
function pickDistractors(bookId, targetId, field, targetText, pos, need = 3) {
  const col = OPTION_FIELDS[field];
  const len = String(targetText || '').length;

  const attempts = [
    { where: 'AND w.pos = ? AND length(' + col + ') BETWEEN ? AND ?', params: [pos, Math.max(2, len - 8), len + 8] },
    { where: 'AND w.pos = ?', params: [pos] },
    { where: '', params: [] },
  ];

  const picked = [];
  const seen = new Set([String(targetText)]);

  for (const a of attempts) {
    if (picked.length >= need) break;
    const rows = db.query(
      `SELECT w.id, ${col} AS txt
         FROM book_words bw
         JOIN words w ON w.id = bw.word_id
        WHERE bw.book_id = ? AND w.id <> ? ${a.where}
        ORDER BY RANDOM() LIMIT 40`,
      [bookId, targetId, ...a.params]
    );
    for (const r of rows) {
      const key = String(r.txt);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      picked.push({ id: r.id, text: r.txt });
      if (picked.length >= need) break;
    }
  }
  return picked;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 出一组题
 * query: book / count / type(en2cn|cn2en|mix) / scope(all|started|due|unit) / unit
 */
router.get(
  '/',
  wrap((req, res) => {
    const book = db.queryOne('SELECT * FROM books WHERE code = ?', [String(req.query.book || 'cet4')])
      || db.queryOne('SELECT * FROM books ORDER BY sort_order LIMIT 1');
    const count = int(req.query.count, 10, 1, 50);
    const settings = db.getSettings();
    const type = ['en2cn', 'cn2en', 'mix'].includes(req.query.type) ? req.query.type : settings.quiz_type;
    const scope = ['all', 'started', 'due', 'unit'].includes(req.query.scope) ? req.query.scope : 'all';
    const now = new Date().toISOString();

    const where = ['bw.book_id = ?'];
    const params = [book.id];

    if (scope === 'started') { where.push('p.word_id IS NOT NULL'); }
    if (scope === 'due') { where.push('p.due_at IS NOT NULL AND p.due_at <= ?'); params.push(now); }
    if (scope === 'unit') { where.push('bw.unit_id = ?'); params.push(int(req.query.unit, 0, 1)); }

    // 释义必须够长，太短的词做选项没有区分度
    where.push("length(w.meaning) >= 3");

    const words = db.query(
      `SELECT w.id, w.spelling, w.phonetic, w.pos, w.meaning, w.meaning_alt, w.exchange,
              w.collins, w.oxford, u.name AS unit_name
         FROM book_words bw
         JOIN words w ON w.id = bw.word_id
         LEFT JOIN progress p ON p.word_id = w.id
         LEFT JOIN units u ON u.id = bw.unit_id
        WHERE ${where.join(' AND ')}
        ORDER BY RANDOM() LIMIT ?`,
      [...params, count]
    );

    if (!words.length) {
      return res.json({ book, type, scope, questions: [], message: '该范围内没有可用于出题的单词' });
    }

    const questions = words.map((w, i) => {
      const t = type === 'mix' ? (Math.random() < 0.5 ? 'en2cn' : 'cn2en') : type;
      const isEn = t === 'en2cn';

      // 中文释义取前两段，避免选项过长
      const answerText = isEn
        ? w.meaning.split('；').slice(0, 2).join('；')
        : w.spelling;

      const distractors = pickDistractors(
        book.id,
        w.id,
        isEn ? 'meaning' : 'spelling',
        answerText,
        w.pos,
        3
      );

      // 每个选项一个 key，正确答案的 key 记在服务端（下面建 session）
      const correctKey = makeKey();
      const options = shuffle([
        { key: correctKey, text: answerText },
        ...distractors.map((d) => ({
          key: makeKey(),
          text: isEn ? d.text.split('；').slice(0, 2).join('；') : d.text,
        })),
      ]);

      return {
        index: i,
        type: t,
        wordId: w.id,
        prompt: isEn ? w.spelling : w.meaning.split('；').slice(0, 2).join('；'),
        phonetic: w.phonetic,
        pos: w.pos,
        unitName: w.unit_name,
        collins: w.collins,
        oxford: w.oxford,
        options,
        // 只给服务端用，下面会删掉再发给前端
        _correctKey: correctKey,
      };
    }).filter((q) => q.options.length >= 3);

    /* 把正确答案**完全留在服务端**：发给前端的题目里既没有 correct 标志，
       也没有「哪个选项是对的」的 key。前端只拿到一组随机 key，
       提交时回报自己选了哪个，正确与否只有服务端知道。 */
    pruneSessions();
    const sessionId = makeKey();
    sessions.set(sessionId, {
      bookId: book.id,
      // 按位置存：前端按原顺序提交作答，服务端按下标比对。
      // 用数组而不是 Map<wordId, key>，是因为同一组里可能出现重复的词。
      wordIds: questions.map((q) => q.wordId),
      keys: questions.map((q) => q._correctKey),
      issuedAt: Date.now(),
      submits: [],
    });
    for (const q of questions) delete q._correctKey;

    res.json({ book, type, scope, sessionId, total: questions.length, questions });
  })
);

/**
 * 提交测试结果。
 *
 * 判分完全由服务端做：前端只提交「选了哪个 key」（`chosen`），
 * 服务端拿 session 里存的正确答案比对。前端传来的 `correct` 字段**一律忽略**。
 *
 * 兼容性：老页面（没有 sessionId）会退回旧行为 —— 采信 `correct`。
 * 这条分支没有防重放保护，所以只作为过渡；刷新页面后就会走安全路径。
 */
router.post(
  '/submit',
  wrap((req, res) => {
    const bookCode = String(req.body?.bookCode || '');
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!answers.length) return res.status(400).json({ error: 'answers 不能为空' });

    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    const session = sessionId ? sessions.get(sessionId) : null;

    // 会话在、但已经交过很多次 → 判定为重复提交（脚本刷流水）
    if (session) {
      const now = Date.now();
      session.submits = session.submits.filter((t) => now - t < SUBMIT_WINDOW_MS);
      if (session.submits.length >= SUBMIT_MAX) {
        return res.status(429).json({ error: '这一组题已经提交过了，请重新出一组' });
      }
      session.submits.push(now);
    }

    const results = [];
    db.transaction(() => {
      for (let i = 0; i < answers.length; i++) {
        const a = answers[i];
        const wordId = int(a.wordId, 0, 1);
        const word = db.queryOne('SELECT id, spelling, meaning FROM words WHERE id = ?', [wordId]);
        if (!word) continue;

        /* ---- 判分：服务端说了算 ---- */
        let correct;
        let correctKey = '';
        const chosenKey = typeof a.chosen === 'string' ? a.chosen : '';
        /* 前端带上题目下标（中途交卷时数组会短于题目数，靠下标才对得准）。
           没带就按数组位置兜底。 */
        const qIndex = Number.isInteger(a.index) && a.index >= 0 ? a.index : i;
        if (session) {
          // 作答必须属于这一组题，且下标要对得上（防止拿别处的 wordId 凑数）
          const expectedWordId = session.wordIds[qIndex];
          correctKey = session.keys[qIndex] || '';
          correct = (expectedWordId === wordId && chosenKey && chosenKey === correctKey) ? 1 : 0;
        } else {
          // 老页面过渡分支
          correct = a.correct ? 1 : 0;
        }

        const prev = getProgress(wordId);
        const rating = correct ? 'known' : 'unknown';
        const next = srs.schedule(prev, rating);

        next.known_count = prev.known_count || 0;
        next.vague_count = prev.vague_count || 0;
        next.unknown_count = prev.unknown_count || 0;
        next.quiz_right = (prev.quiz_right || 0) + (correct ? 1 : 0);
        next.quiz_wrong = (prev.quiz_wrong || 0) + (correct ? 0 : 1);

        saveProgress(wordId, next);
        logStudy({ wordId, bookCode, mode: 'quiz', rating: correct ? 'right' : 'wrong', correct });

        results.push({
          index: qIndex,
          wordId,
          spelling: word.spelling,
          meaning: word.meaning,
          correct: !!correct,
          // 交卷后才回传「正确答案是哪个选项」—— 答题过程中前端无从得知
          correctKey,
          chosenKey,
          stage: next.stage,
          due_at: next.due_at,
        });
      }
    });

    const right = results.filter((r) => r.correct).length;
    const wrong = results.length - right;

    res.json({
      total: results.length,
      right,
      wrong,
      accuracy: results.length ? Math.round((right / results.length) * 100) : 0,
      mistakes: results.filter((r) => !r.correct),
      results,
      graded: session ? 'server' : 'legacy',
    });
  })
);

/**
 * 顽固词（leech）清单：老是记不住、该处理一下的词。
 *
 * 判定 = 「测试答错 + 翻卡标记不认识」的累计次数 >= leech_threshold（默认 6）。
 *
 * 为什么需要这个东西：复习队列是按「错误次数加权」把难词排到**最前面**的，
 * 所以最记不住的词每次都第一个来 —— 如果不给出口，它们会永远占用你的时间。
 * Anki 的做法是打 leech 标记并暂停（https://docs.ankiweb.net/leeches.html），
 * 这里保留同样的三个出路：暂缓 / 写助记 / 移出错题本。
 *
 * leech 是**推导出来的**，不落库（不需要额外字段，阈值改了立刻生效）。
 */
router.get(
  '/leeches',
  wrap((req, res) => {
    const bookCode = req.query.book ? String(req.query.book) : null;
    const settings = db.getSettings();
    const threshold = int(settings.leech_threshold, 6, 1, 1000);
    const limit = int(req.query.limit, 100, 1, 500);

    /*
     * 参数顺序必须跟 SQL 里 `?` 出现的顺序一致。
     * JOIN 子句在 WHERE 之前，所以**词库 code 要排在阈值前面** ——
     * 顺序弄反不会报错，只会静默返回空结果（踩过：book=cet4 时永远 0 条）。
     */
    const params = [];
    let joinBook = '';
    if (bookCode) {
      joinBook = 'JOIN book_words bw ON bw.word_id = p.word_id JOIN books b ON b.id = bw.book_id AND b.code = ?';
      params.push(bookCode);
    }
    params.push(threshold, limit);

    const rows = db.query(
      `SELECT w.id, w.spelling, w.phonetic, w.pos, w.meaning, w.exchange,
              p.quiz_wrong, p.unknown_count, p.vague_count, p.stage, p.status,
              p.due_at, COALESCE(p.suspended,0) AS suspended,
              COALESCE(p.note,'') AS note,
              (COALESCE(p.quiz_wrong,0) + COALESCE(p.unknown_count,0)) AS lapses
         FROM progress p
         JOIN words w ON w.id = p.word_id
         ${joinBook}
        WHERE (COALESCE(p.quiz_wrong,0) + COALESCE(p.unknown_count,0)) >= ?
        ORDER BY lapses DESC, p.quiz_wrong DESC
        LIMIT ?`,
      params
    );

    res.json({
      threshold,
      total: rows.length,
      // 已经处理过的（暂缓了）单独标出来，前端可以分区展示
      suspended: rows.filter((r) => r.suspended).length,
      items: rows,
    });
  })
);

/** 错题本：累计答错过的词，按错误次数排序 */
router.get(
  '/mistakes',
  wrap((req, res) => {
    const bookCode = req.query.book ? String(req.query.book) : null;
    const limit = int(req.query.limit, 100, 1, 500);

    const params = [];
    let joinBook = '';
    if (bookCode) {
      joinBook = 'JOIN book_words bw ON bw.word_id = p.word_id JOIN books b ON b.id = bw.book_id AND b.code = ?';
      params.push(bookCode);
    }

    const rows = db.query(
      `SELECT w.id, w.spelling, w.phonetic, w.pos, w.meaning, w.exchange,
              p.quiz_wrong, p.unknown_count, p.stage, p.status, p.due_at,
              COALESCE(p.suspended,0) AS suspended,
              COALESCE(p.note,'') AS note
         FROM progress p
         JOIN words w ON w.id = p.word_id
         ${joinBook}
        WHERE ${isMistake('p')}
        ORDER BY p.quiz_wrong DESC, p.unknown_count DESC
        LIMIT ?`,
      [...params, limit]
    );
    res.json({ total: rows.length, items: rows });
  })
);

/** 把单词移出错题本（保留学习进度与复习排期） */
router.post(
  '/mistakes/clear',
  wrap((req, res) => {
    const wordId = int(req.body?.wordId, 0, 0);

    // 错题本的收录条件是「测试答错 或 翻卡标记不认识 或 手动加入」，
    // 所以清除必须把三个来源一起归零。只清一部分的话，靠另外两条进来的词
    // 会一直赖在列表里删不掉 —— 这正是之前踩过的 bug。
    // 不要动 stage / status / due_at：错题本只是一份「难词清单」，
    // 把词移出它不该打乱艾宾浩斯的复习排期。
    if (wordId) {
      db.execute(
        'UPDATE progress SET quiz_wrong = 0, unknown_count = 0, marked = 0 WHERE word_id = ?',
        [wordId]
      );
    } else {
      db.execute('UPDATE progress SET quiz_wrong = 0, unknown_count = 0, marked = 0');
    }
    res.json({ ok: true, wordId: wordId || null });
  })
);

module.exports = router;
