'use strict';

/** 学习核心：今日任务队列 + 翻卡片反馈（艾宾浩斯排期入口） */

const express = require('express');
const db = require('../db');
const srs = require('../srs');
const { wrap, int, dayStartIso, todayStr, saveProgress, logStudy, getProgress, loadBooks, streak, isMistake, isUntouched, isStarted } = require('../util');

const router = express.Router();

const WORD_COLS = `w.id, w.spelling, w.phonetic, w.pos, w.meaning, w.meaning_alt,
                   w.definition, w.exchange, w.collins, w.oxford, w.frq,
                   bw.unit_id, u.name AS unit_name`;

/** 取词库（带学习统计），带 code 时优先匹配，取不到就退回第一个 */
function bookIdOf(code) {
  if (code) {
    const hit = loadBooks(code);
    if (hit.length) return hit[0];
  }
  return loadBooks()[0];
}

/**
 * 给一批单词补上「常见搭配 + 真题例句」。
 * 搭配来自大语料统计（tools/build-phrases.js），例句来自真题正文本身。
 * 没数据的词就留空数组，前端不显示那一段。
 */
function attachPhrases(rows) {
  if (!rows || !rows.length) return rows;
  const ids = rows.map((r) => r.id).filter((x) => Number.isInteger(x));
  if (!ids.length) return rows;
  const marks = ids.map(() => '?').join(',');
  const ph = db.query(
    `SELECT word_id, phrase, example FROM word_phrases
      WHERE word_id IN (${marks}) ORDER BY word_id, seq`,
    ids
  );
  const byWord = new Map();
  for (const p of ph) {
    if (!byWord.has(p.word_id)) byWord.set(p.word_id, []);
    byWord.get(p.word_id).push(p);
  }
  for (const r of rows) {
    const list = byWord.get(r.id) || [];
    r.phrases = list.map((x) => x.phrase);
    const withEx = list.find((x) => x.example);
    r.example = withEx ? withEx.example : '';
  }
  return rows;
}

/** 今日各项计数 */
function todayCounters(bookId) {
  const day = todayStr();
  const dayStart = dayStartIso(day);

  const newLearned = db.queryOne(
    `SELECT COUNT(*) AS c FROM progress p
       JOIN book_words bw ON bw.word_id = p.word_id AND bw.book_id = ?
      WHERE p.first_seen_at IS NOT NULL AND p.first_seen_at >= ?`,
    [bookId, dayStart]
  ).c;

  // 「复习了几个」以**本轮过关**为准（card_done），
  // 只点了一次就退出的不算 —— 否则数字会领先于实际完成度
  const reviewed = db.queryOne(
    `SELECT COUNT(DISTINCT l.word_id) AS c FROM logs l
       JOIN book_words bw ON bw.word_id = l.word_id AND bw.book_id = ?
      WHERE l.day = ? AND l.mode = 'card_done' AND l.word_id IN (
        SELECT word_id FROM progress WHERE first_seen_at IS NOT NULL AND first_seen_at < ?
      )`,
    [bookId, day, dayStart]
  ).c;

  const cardCount = db.queryOne(
    `SELECT COUNT(*) AS c FROM logs l
       JOIN book_words bw ON bw.word_id = l.word_id AND bw.book_id = ?
      WHERE l.day = ? AND l.mode = 'card'`,
    [bookId, day]
  ).c;

  // 正确率只统计「第一次作答」（card = 翻卡首答，quiz = 测试作答）。
  // card_repeat（本轮重复）和 card_done（过关归档）都不计入，否则反复重来会拉高正确率
  const right = db.queryOne(
    `SELECT COALESCE(SUM(l.correct),0) AS s, COUNT(*) AS c FROM logs l
       JOIN book_words bw ON bw.word_id = l.word_id AND bw.book_id = ?
      WHERE l.day = ? AND l.mode IN ('card','quiz')`,
    [bookId, day]
  );
  const seconds = db.queryOne('SELECT COALESCE(seconds,0) AS s FROM checkins WHERE day = ?', [day])?.s || 0;

  return { day, newLearned, reviewed, cardCount, right: right.s, total: right.c, seconds };
}

/**
 * 学习计划。两种模式**互不混合**：
 *   mode=new    （默认）只给新词，一批 batch_size 个；一批全部过关再取下一批
 *   mode=review 只给到期的复习词，按「错误次数」从多到少排
 * query: book=cet4 | mode=new|review | ignoreLimit=1（忽略每日上限，继续刷）
 */
router.get(
  '/plan',
  wrap((req, res) => {
    const book = bookIdOf(req.query.book);
    const settings = db.getSettings();
    const ignoreLimit = req.query.ignoreLimit === '1';
    const mode = req.query.mode === 'review' ? 'review' : 'new';
    const now = new Date().toISOString();

    const counters = todayCounters(book.id);
    const dailyNew = int(settings.daily_new, 20, 0, 500);
    const dailyReview = int(settings.daily_review, 120, 0, 2000);
    const batchSize = int(settings.batch_size, 5, 1, 50);

    const dueTotal = db.queryOne(
      `SELECT COUNT(*) AS c FROM progress p
         JOIN book_words bw ON bw.word_id = p.word_id AND bw.book_id = ?
        WHERE p.due_at IS NOT NULL AND p.due_at <= ?
          AND COALESCE(p.suspended,0) = 0`,
      [book.id, now]
    ).c;

    const newAvail = db.queryOne(
      `SELECT COUNT(*) AS c FROM book_words bw
         LEFT JOIN progress p ON p.word_id = bw.word_id
        WHERE bw.book_id = ? AND ${isUntouched('p')}`,
      [book.id]
    ).c;

    const base = {
      book,
      now,
      mode,
      counters: {
        ...counters,
        dailyNew,
        dailyReview,
        newRemain: Math.max(0, dailyNew - counters.newLearned),
        reviewRemain: Math.max(0, dailyReview - counters.reviewed),
      },
      pools: { dueTotal, newAvail },
      settings,
    };

    /* ---------------- 复习模式 ---------------- */
    if (mode === 'review') {
      /*
       * 复习**不设硬上限**：到期多少就给多少，一直做到没有到期的为止。
       *
       * 之前用的是「daily_review − 今天已复习」，导致一个很让人困惑的现象：
       * 用户做完了当天排进来的词（页面说「今天的复习做完了」），
       * 但因为额度用光，剩下到期的词根本没排进队列 ——
       * 而侧边栏徽标照旧统计它们，于是「已经复习完了还显示 99+」。
       *
       * daily_review 现在只作为「今日目标」用于进度展示，不再截断队列。
       * 这里留一个大上限只是防止长期不复习后一次拉太多。
       */
      const safetyCap = 1000;
      /*
       * 排序依据是「错误次数加权累加」：
       *   不认识 ×3 + 模糊 ×1 + 测试做错 ×2
       * 平手时看得更久没碰的（due_at 更早）优先。
       * 这样老是记不住的词每次都排在前面，而不是平均撒开。
       */
      const reviews = db.query(
        `SELECT ${WORD_COLS}, p.stage, p.status, p.due_at, p.reps,
                COALESCE(p.favorite,0) AS favorite,
                COALESCE(p.note,'') AS note,
                COALESCE(p.suspended,0) AS suspended,
                (COALESCE(p.unknown_count,0) * 3
                 + COALESCE(p.vague_count,0) * 1
                 + COALESCE(p.quiz_wrong,0) * 2) AS error_score
           FROM progress p
           JOIN book_words bw ON bw.word_id = p.word_id AND bw.book_id = ?
           JOIN words w ON w.id = p.word_id
           LEFT JOIN units u ON u.id = bw.unit_id
          WHERE p.due_at IS NOT NULL AND p.due_at <= ?
            AND COALESCE(p.suspended,0) = 0
          ORDER BY error_score DESC, p.due_at ASC
          LIMIT ?`,
        [book.id, now, safetyCap]
      ).map((r) => ({ ...r, isNew: 0 }));

      const withPhrases = attachPhrases(reviews);

      /*
       * 暂缓的顽固词：单独查出来给前端展示「已暂缓 N 个」并可随时恢复。
       * 它们**不进 queue** —— 这正是暂缓的意义。
       */
      const suspended = db.query(
        `SELECT ${WORD_COLS}, p.stage, p.status, p.due_at, p.reps,
                COALESCE(p.favorite,0) AS favorite,
                COALESCE(p.note,'') AS note,
                1 AS suspended,
                (COALESCE(p.unknown_count,0) * 3
                 + COALESCE(p.vague_count,0) * 1
                 + COALESCE(p.quiz_wrong,0) * 2) AS error_score
           FROM progress p
           JOIN book_words bw ON bw.word_id = p.word_id AND bw.book_id = ?
           JOIN words w ON w.id = p.word_id
           LEFT JOIN units u ON u.id = bw.unit_id
          WHERE COALESCE(p.suspended,0) = 1
          ORDER BY error_score DESC
          LIMIT ?`,
        [book.id, safetyCap]
      ).map((r) => ({ ...r, isNew: 0 }));

      return res.json({
        ...base,
        queue: withPhrases,
        reviews: withPhrases,
        news: [],
        suspended: attachPhrases(suspended),
        suspendedCount: suspended.length,
        batchSize: withPhrases.length,
        dueNow: withPhrases.length,
      });
    }

    /* ---------------- 学新词模式 ---------------- */
    /*
     * 注意：这里的 daily_new 只是**目标**，不是硬上限 ——
     * 只要词库里还有没学过的词就继续给，用户可以一直往下学。
     * newRemain 只用来在界面上显示「今日目标还剩多少」。
     */
    const newRemain = ignoreLimit
      ? Math.max(dailyNew, 10)
      : Math.max(0, dailyNew - counters.newLearned);
    const take = Math.min(batchSize, newAvail);

    // 新词：按词频顺序（Unit 顺序即词频降序）
    const order = settings.new_order === 'alpha' ? 'w.lower ASC' : 'bw.sort_order ASC';
    const news = take > 0
      ? db.query(
          `SELECT ${WORD_COLS}, NULL AS stage, 'new' AS status, NULL AS due_at, 0 AS reps,
                  0 AS favorite, COALESCE(p.note,'') AS note, 0 AS suspended
             FROM book_words bw
             JOIN words w ON w.id = bw.word_id
             LEFT JOIN progress p ON p.word_id = w.id
             LEFT JOIN units u ON u.id = bw.unit_id
            WHERE bw.book_id = ? AND ${isUntouched('p')}
            ORDER BY ${order}
            LIMIT ?`,
          [book.id, take]
        ).map((r) => ({ ...r, isNew: 1, error_score: 0 }))
      : [];

    const withPhrases = attachPhrases(news);
    res.json({
      ...base,
      queue: withPhrases,
      news: withPhrases,
      reviews: [],
      batchSize: take,
      batchOf: batchSize,
      newRemain,
      newAvail,
      newLearned: counters.newLearned,
      overGoal: counters.newLearned >= dailyNew,
      batchesLeft: Math.ceil(newAvail / batchSize),
    });
  })
);


/**
 * 卡片作答。分三个阶段提交（前端驱动）：
 *
 *   phase = 'first'   对这个词的**第一次**作答
 *                     → 只记流水（mode=card，计入正确率），**不立刻排期**
 *   phase = 'repeat'  本轮里重复出现的作答
 *                     → 只记流水（mode=card_repeat），不进打卡、不进正确率
 *   phase = 'pass'    本轮过关（连续答对 2 次）
 *                     → 这时候才按「第一次作答」的质量定下次复习时间
 *
 * 为什么要延到 pass 才排期：
 *   不认识的词会被重复到会为止，如果第一次不认识就把它打回阶段 0，
 *   那「重复到会了」这件事就白费了。所以等到过关再排期，并且——
 *   首次是「不认识」但最终过关的，按「认识」正常推进一档。
 *
 * phase 缺省时走旧版逻辑（记流水 + 立刻排期），兼容没刷新的页面。
 */
router.post(
  '/answer',
  wrap((req, res) => {
    const wordId = int(req.body?.wordId, 0, 1);
    const rating = String(req.body?.rating || '');
    if (wordId <= 0) return res.status(400).json({ error: 'wordId 无效' });

    const word = db.queryOne('SELECT id, spelling FROM words WHERE id = ?', [wordId]);
    if (!word) return res.status(404).json({ error: '单词不存在' });

    const bookCode = String(req.body?.bookCode || '');
    const settings = db.getSettings();
    const batchSize = int(settings.batch_size, 5, 1, 50);
    const phase = typeof req.body?.phase === 'string' ? req.body.phase : 'legacy';

    /* ---------- 本轮重复：只留流水，什么都不改 ---------- */
    if (phase === 'repeat') {
      if (!srs.RATING_LABEL[rating]) return res.status(400).json({ error: 'rating 无效' });
      logStudy({
        wordId,
        bookCode,
        mode: 'card_repeat',
        rating,
        correct: rating === 'known' ? 1 : 0,
        countStats: false,
      });
      return res.json({ phase, wordId, spelling: word.spelling, recorded: 'repeat' });
    }

    /* ---------- 首次作答：记流水，排期后延 ---------- */
    if (phase === 'first') {
      if (!srs.RATING_LABEL[rating]) return res.status(400).json({ error: 'rating 无效' });
      logStudy({ wordId, bookCode, mode: 'card', rating, correct: rating === 'known' ? 1 : 0 });
      return res.json({ phase, wordId, spelling: word.spelling, scheduled: false });
    }

    /* ---------- 过关归档（含旧版逻辑） ---------- */
    const firstRaw = String(req.body?.firstRating || rating);
    const firstRating = srs.RATING_LABEL[firstRaw] ? firstRaw : (srs.RATING_LABEL[rating] ? rating : '');
    if (!firstRating) return res.status(400).json({ error: 'rating 必须是 known / vague / unknown' });

    const prev = getProgress(wordId) || {};

    /*
     * 排期只看**第一次作答**，分两种结果：
     *   第一次就「认识」→ 大步往后推（一遍就过，跳 2 档）
     *   第一次是「不认识」或「模糊」→ 回到明天
     * 所以本轮循环到会这件事，不会把它变成「已掌握」—— 该明天复习还是明天。
     */
    const effective = firstRating === 'known' ? 'known' : 'unknown';

    const next = srs.schedule(prev, effective);
    // 计数按**第一次作答**记，这样「老是错的词」在复习队列里依然排前面
    next.known_count = (prev.known_count || 0) + (firstRating === 'known' ? 1 : 0);
    next.vague_count = (prev.vague_count || 0) + (firstRating === 'vague' ? 1 : 0);
    next.unknown_count = (prev.unknown_count || 0) + (firstRating === 'unknown' ? 1 : 0);
    next.quiz_right = prev.quiz_right || 0;
    next.quiz_wrong = prev.quiz_wrong || 0;

    saveProgress(wordId, next);
    // 过关是「归档」，不算一次作答，所以不进正确率
    logStudy({
      wordId,
      bookCode,
      mode: phase === 'pass' ? 'card_done' : 'card',
      rating: effective,
      correct: 1,
      countStats: phase !== 'pass',
    });

    res.json({
      phase,
      wordId,
      spelling: word.spelling,
      firstRating,
      effective,
      progress: {
        status: next.status,
        stage: next.stage,
        reps: next.reps,
        due_at: next.due_at,
      },
      feedback: {
        rating: effective,
        label: srs.RATING_LABEL[effective],
        delayMinutes: next.delayMinutes,
        human: srs.humanInterval(next.delayMinutes),
        stagePercent: srs.stagePercent(next.stage),
        maxStage: srs.MAX_STAGE,
      },
      batchSize,
    });
  })
);


/** 记录本次学习时长（前端会话结束时调用） */
router.post(
  '/time',
  wrap((req, res) => {
    const seconds = int(req.body?.seconds, 0, 0, 36000);
    const day = todayStr();
    db.execute(
      `INSERT INTO checkins(day, learned, correct, wrong, new_words, seconds)
       VALUES(?, 0, 0, 0, 0, ?)
       ON CONFLICT(day) DO UPDATE SET seconds = seconds + excluded.seconds`,
      [day, seconds]
    );
    res.json({ day, added: seconds });
  })
);

/** 今日总览（仪表盘用） */
router.get(
  '/today',
  wrap((req, res) => {
    const book = bookIdOf(req.query.book);
    const counters = todayCounters(book.id);
    const settings = db.getSettings();
    const now = new Date().toISOString();

    const dailyNew = int(settings.daily_new, 20, 0, 500);
    const dailyReview = int(settings.daily_review, 120, 0, 2000);
    // 剩余额度：仪表盘的「开始学习」按钮靠这两个值算本轮卡片数
    counters.dailyNew = dailyNew;
    counters.dailyReview = dailyReview;
    counters.newRemain = Math.max(0, dailyNew - counters.newLearned);
    counters.reviewRemain = Math.max(0, dailyReview - counters.reviewed);

    const dueTotal = db.queryOne(
      `SELECT COUNT(*) AS c FROM progress p
         JOIN book_words bw ON bw.word_id = p.word_id AND bw.book_id = ?
        WHERE p.due_at IS NOT NULL AND p.due_at <= ?
          AND COALESCE(p.suspended,0) = 0`,
      [book.id, now]
    ).c;

    const newAvail = db.queryOne(
      `SELECT COUNT(*) AS c FROM book_words bw
         LEFT JOIN progress p ON p.word_id = bw.word_id
        WHERE bw.book_id = ? AND ${isUntouched('p')}`,
      [book.id]
    ).c;

    /*
     * 总览口径：`started` 必须用 isStarted() —— 只带标记的空行（给未学的词
     * 写笔记/收藏/暂缓时建出来的）不算「学过」。否则它会和
     * 「学习中 + 复习中 + 已掌握」三个桶对不上（实测差 1，正是这种幽灵行）。
     */
    const global = db.queryOne(`
      SELECT (SELECT COUNT(*) FROM progress p WHERE ${isStarted('p')}) AS started,
             (SELECT COUNT(*) FROM progress p WHERE status = 'mastered' AND ${isStarted('p')}) AS mastered,
             (SELECT COUNT(*) FROM progress p WHERE status = 'learning' AND ${isStarted('p')}) AS learning,
             (SELECT COUNT(*) FROM progress p WHERE status = 'reviewing' AND ${isStarted('p')}) AS reviewing,
             (SELECT COUNT(*) FROM progress p WHERE ${isMistake('p')}) AS wrongWords,
             (SELECT COUNT(*) FROM progress p WHERE COALESCE(p.suspended,0) = 1 AND ${isStarted('p')}) AS suspendedWords,
             (SELECT COUNT(*) FROM words) AS total,
             (SELECT COUNT(*) FROM logs) AS totalReviews,
             (SELECT COALESCE(SUM(correct),0) FROM logs) AS rightReviews,
             (SELECT COUNT(*) FROM checkins WHERE learned > 0) AS studyDays,
             (SELECT COALESCE(SUM(seconds),0) FROM checkins) AS seconds
    `);

    // 派生指标在 JS 里算，避免 SQL 里做除零判断
    global.percent = global.total ? Math.round((global.started / global.total) * 100) : 0;
    global.accuracy = global.totalReviews ? Math.round((global.rightReviews / global.totalReviews) * 100) : 0;
    global.minutes = Math.round(global.seconds / 60);

    res.json({
      book,
      counters,
      pools: { dueTotal, newAvail },
      global,
      streak: streak(),
      settings,
      goal: {
        new: Math.min(counters.newLearned, int(settings.daily_new, 20, 0, 500)),
        newTarget: int(settings.daily_new, 20, 0, 500),
        review: Math.min(counters.reviewed, int(settings.daily_review, 120, 0, 2000)),
        reviewTarget: int(settings.daily_review, 120, 0, 2000),
      },
    });
  })
);

module.exports = router;
