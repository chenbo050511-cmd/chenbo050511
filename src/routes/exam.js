'use strict';

/** 真题题库：短文阅读 / 段落匹配的浏览、作答、批改与记录 */

const express = require('express');
const db = require('../db');
const { wrap, int, todayStr } = require('../util');

const router = express.Router();

const KIND_TEXT = { reading: '短文阅读', matching: '段落匹配' };

/* ------------------------------------------------------------------ */
/* 筛选元信息                                                          */
/* ------------------------------------------------------------------ */

router.get(
  '/overview',
  wrap((req, res) => {
    const counts = db.queryOne(`
      SELECT
        (SELECT COUNT(*) FROM exam_sets) AS sets,
        (SELECT COUNT(*) FROM exam_sets WHERE kind='reading') AS reading_sets,
        (SELECT COUNT(*) FROM exam_sets WHERE kind='matching') AS matching_sets,
        (SELECT COUNT(*) FROM exam_papers) AS papers,
        (SELECT COUNT(*) FROM exam_questions) AS questions,
        (SELECT COUNT(*) FROM exam_attempts) AS attempts,
        (SELECT COALESCE(SUM(right_count),0) FROM exam_attempts) AS right_total,
        (SELECT COALESCE(SUM(total),0) FROM exam_attempts) AS answered_total,
        (SELECT COUNT(DISTINCT set_id) FROM exam_attempts) AS done_sets
    `);

    const byLevel = db.query(`
      SELECT p.level,
             COUNT(*) AS sets,
             SUM(CASE WHEN s.kind='reading' THEN 1 ELSE 0 END) AS reading_sets,
             SUM(CASE WHEN s.kind='matching' THEN 1 ELSE 0 END) AS matching_sets
        FROM exam_sets s JOIN exam_papers p ON p.id = s.paper_id
       GROUP BY p.level ORDER BY p.level
    `);

    const byYear = db.query(`
      SELECT p.year, COUNT(DISTINCT p.id) AS papers, COUNT(*) AS sets
        FROM exam_sets s JOIN exam_papers p ON p.id = s.paper_id
       GROUP BY p.year ORDER BY p.year DESC
    `);

    res.json({
      ...counts,
      accuracy: counts.answered_total ? Math.round((counts.right_total / counts.answered_total) * 100) : 0,
      remaining: counts.sets - counts.done_sets,
      byLevel,
      byYear,
    });
  })
);

/* ------------------------------------------------------------------ */
/* 题目列表                                                            */
/* ------------------------------------------------------------------ */

router.get(
  '/sets',
  wrap((req, res) => {
    const where = [];
    const params = [];

    if (req.query.level === 'cet4' || req.query.level === 'cet6') {
      where.push('p.level = ?');
      params.push(req.query.level);
    }
    if (req.query.kind === 'reading' || req.query.kind === 'matching') {
      where.push('s.kind = ?');
      params.push(req.query.kind);
    }
    if (req.query.year && /^\d{4}$/.test(String(req.query.year))) {
      where.push('p.year = ?');
      params.push(Number(req.query.year));
    }
    if (req.query.q) {
      where.push('(s.title LIKE ? OR p.title LIKE ? OR p.code LIKE ?)');
      const like = `%${String(req.query.q).trim()}%`;
      params.push(like, like, like);
    }

    const status = String(req.query.status || 'all');
    if (status === 'todo') where.push('NOT EXISTS (SELECT 1 FROM exam_attempts a WHERE a.set_id = s.id)');
    if (status === 'done') where.push('EXISTS (SELECT 1 FROM exam_attempts a WHERE a.set_id = s.id)');
    if (status === 'wrong') {
      where.push(`EXISTS (SELECT 1 FROM exam_answers an JOIN exam_attempts a ON a.id = an.attempt_id
                           WHERE a.set_id = s.id AND an.correct = 0)`);
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const page = int(req.query.page, 1, 1, 10000);
    const size = int(req.query.size, 30, 1, 100);

    const total = db.queryOne(
      `SELECT COUNT(*) AS c FROM exam_sets s JOIN exam_papers p ON p.id = s.paper_id ${whereSql}`,
      params
    ).c;

    const items = db.query(
      `SELECT s.id, s.kind, s.title, s.question_count, s.word_count,
              p.code, p.level, p.year, p.month, p.set_no, p.title AS paper_title,
              (SELECT COUNT(*) FROM exam_attempts a WHERE a.set_id = s.id) AS attempts,
              (SELECT right_count FROM exam_attempts a WHERE a.set_id = s.id ORDER BY a.id DESC LIMIT 1) AS last_right,
              (SELECT ROUND(right_count * 100.0 / total) FROM exam_attempts a WHERE a.set_id = s.id
                ORDER BY right_count * 1.0 / total DESC LIMIT 1) AS best_score,
              (SELECT created_at FROM exam_attempts a WHERE a.set_id = s.id ORDER BY a.id DESC LIMIT 1) AS last_at,
              EXISTS (SELECT 1 FROM exam_answers an JOIN exam_attempts a ON a.id = an.attempt_id
                       WHERE a.set_id = s.id AND an.correct = 0) AS has_wrong
         FROM exam_sets s JOIN exam_papers p ON p.id = s.paper_id
         ${whereSql}
        ORDER BY p.year DESC, p.month DESC, p.set_no ASC, s.seq ASC
        LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size]
    );

    // 试卷分组，前端按套卷展示更贴近真实考试
    res.json({
      total,
      page,
      size,
      pages: Math.max(1, Math.ceil(total / size)),
      kindText: KIND_TEXT,
      items,
    });
  })
);

/* ------------------------------------------------------------------ */
/* 单组详情（不含答案，交卷后才给）                                     */
/* ------------------------------------------------------------------ */

router.get(
  '/sets/:id',
  wrap((req, res) => {
    const id = int(req.params.id, 0, 1);
    const set = db.queryOne(
      `SELECT s.*, p.code, p.level, p.year, p.month, p.set_no, p.title AS paper_title
         FROM exam_sets s JOIN exam_papers p ON p.id = s.paper_id
        WHERE s.id = ?`,
      [id]
    );
    if (!set) return res.status(404).json({ error: '题目不存在' });

    const questions = db.query(
      `SELECT id, seq, q_number, stem FROM exam_questions WHERE set_id = ? ORDER BY seq`,
      [id]
    ).map((q) => ({
      ...q,
      options: db.query(
        `SELECT id, label, text FROM exam_options WHERE question_id = ? ORDER BY seq`,
        [q.id]
      ),
    }));

    const paragraphs = set.kind === 'matching'
      ? db.query(`SELECT label, text, seq FROM exam_paragraphs WHERE set_id = ? ORDER BY seq`, [id])
      : [];

    // 阅读短文的段落：源题库的正文没有分段，这些是从真题 PDF 按首行缩进还原出来的。
    // 取不到就是空数组，前端会退回整段显示。
    const readingParagraphs = set.kind === 'reading'
      ? db.query(`SELECT text FROM exam_reading_paragraphs WHERE set_id = ? ORDER BY seq`, [id])
          .map((r) => r.text)
      : [];

    const lastAttempt = db.queryOne(
      `SELECT id, right_count, total, created_at FROM exam_attempts
        WHERE set_id = ? ORDER BY id DESC LIMIT 1`,
      [id]
    );

    res.json({ set, questions, paragraphs, readingParagraphs, lastAttempt, kindText: KIND_TEXT[set.kind] });
  })
);

/* ------------------------------------------------------------------ */
/* 交卷批改                                                            */
/* ------------------------------------------------------------------ */

router.post(
  '/submit',
  wrap((req, res) => {
    const setId = int(req.body?.setId, 0, 1);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const durationMs = int(req.body?.durationMs, 0, 0, 6 * 3600 * 1000);

    const set = db.queryOne('SELECT * FROM exam_sets WHERE id = ?', [setId]);
    if (!set) return res.status(404).json({ error: '题目不存在' });

    // 以「整组的全部题目」为分母，未作答按错计。
    // 如果只用前端提交上来的答案算分母，漏答的题会让分数虚高
    // （比如 5 题只答 2 题全对，就会显示 2/2 = 100%）—— 那不是真题的成绩。
    const allQuestions = db.query(
      `SELECT id, answer, stem, q_number, COALESCE(explanation,'') AS explanation
         FROM exam_questions WHERE set_id = ? ORDER BY seq`,
      [setId]
    );
    if (!allQuestions.length) return res.status(400).json({ error: '该组没有题目' });

    const chosenOf = new Map();
    for (const a of answers) {
      const qid = int(a.questionId, 0, 1);
      chosenOf.set(qid, String(a.chosen || '').trim().toUpperCase().slice(0, 1));
    }

    const paraText = set.kind === 'matching'
      ? new Map(db.query(`SELECT label, text FROM exam_paragraphs WHERE set_id = ?`, [setId]).map((p) => [p.label, p.text]))
      : new Map();

    let right = 0;
    const detail = [];

    db.transaction(() => {
      const attemptId = Number(
        db.execute(
          `INSERT INTO exam_attempts(set_id, total, right_count, wrong_count, duration_ms, day, created_at)
           VALUES(?,?,?,?,?,?,?)`,
          [setId, allQuestions.length, 0, 0, durationMs, todayStr(), new Date().toISOString()]
        ).lastInsertRowid
      );

      const insAns = db.db.prepare(
        `INSERT INTO exam_answers(attempt_id, question_id, chosen, correct) VALUES(?,?,?,?)`
      );

      for (const q of allQuestions) {
        const chosen = chosenOf.get(q.id) || '';
        const ok = chosen && chosen === q.answer ? 1 : 0;
        if (ok) right++;
        insAns.run(attemptId, q.id, chosen, ok);
        detail.push({
          questionId: q.id,
          qNumber: q.q_number,
          stem: q.stem,
          chosen,
          answer: q.answer,
          correct: !!ok,
          answerText: paraText.get(q.answer) ? paraText.get(q.answer).slice(0, 200) : '',
          explanation: q.explanation || '',
        });
      }

      const total = detail.length;
      db.execute(
        `UPDATE exam_attempts SET total = ?, right_count = ?, wrong_count = ? WHERE id = ?`,
        [total, right, total - right, attemptId]
      );

      res.json({
        attemptId,
        total,
        right,
        wrong: total - right,
        blank: detail.filter((x) => !x.chosen).length,
        accuracy: total ? Math.round((right / total) * 100) : 0,
        durationMs,
        detail,
      });
    });
  })
);

/* ------------------------------------------------------------------ */
/* 记录                                                                */
/* ------------------------------------------------------------------ */

router.get(
  '/records',
  wrap((req, res) => {
    const page = int(req.query.page, 1, 1, 10000);
    const size = int(req.query.size, 20, 1, 100);

    const total = db.queryOne('SELECT COUNT(*) AS c FROM exam_attempts').c;
    const items = db.query(
      `SELECT a.id, a.total, a.right_count, a.wrong_count, a.duration_ms, a.day, a.created_at,
              s.id AS set_id, s.kind, s.title, p.code, p.level, p.year, p.month, p.set_no, p.title AS paper_title
         FROM exam_attempts a
         JOIN exam_sets s ON s.id = a.set_id
         JOIN exam_papers p ON p.id = s.paper_id
        ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      [size, (page - 1) * size]
    );

    const stats = db.queryOne(`
      SELECT COUNT(*) AS attempts,
             COALESCE(SUM(total),0) AS answered,
             COALESCE(SUM(right_count),0) AS right_total,
             COALESCE(SUM(duration_ms),0) AS duration,
             COUNT(DISTINCT day) AS days
        FROM exam_attempts
    `);
    stats.accuracy = stats.answered ? Math.round((stats.right_total / stats.answered) * 100) : 0;
    stats.minutes = Math.round(stats.duration / 60000);

    const byKind = db.query(`
      SELECT s.kind, COUNT(*) AS attempts,
             COALESCE(SUM(a.total),0) AS answered,
             COALESCE(SUM(a.right_count),0) AS right_total
        FROM exam_attempts a JOIN exam_sets s ON s.id = a.set_id
       GROUP BY s.kind
    `).map((r) => ({
      ...r,
      accuracy: r.answered ? Math.round((r.right_total / r.answered) * 100) : 0,
      text: KIND_TEXT[r.kind],
    }));

    res.json({ total, page, size, pages: Math.max(1, Math.ceil(total / size)), items, stats, byKind });
  })
);

/** 某次作答的详情 */
router.get(
  '/records/:id',
  wrap((req, res) => {
    const id = int(req.params.id, 0, 1);
    const attempt = db.queryOne(
      `SELECT a.*, s.kind, s.title, s.passage, p.code, p.title AS paper_title
         FROM exam_attempts a JOIN exam_sets s ON s.id = a.set_id
         JOIN exam_papers p ON p.id = s.paper_id WHERE a.id = ?`,
      [id]
    );
    if (!attempt) return res.status(404).json({ error: '记录不存在' });

    const detail = db.query(
      `SELECT an.question_id, an.chosen, an.correct, q.seq, q.q_number, q.stem, q.answer,
              COALESCE(q.explanation,'') AS explanation
         FROM exam_answers an JOIN exam_questions q ON q.id = an.question_id
        WHERE an.attempt_id = ? ORDER BY q.seq`,
      [id]
    ).map((r) => ({
      ...r,
      options: db.query(`SELECT label, text FROM exam_options WHERE question_id = ? ORDER BY seq`, [r.question_id]),
    }));

    res.json({ attempt, detail });
  })
);

/** 错题本：跨所有记录聚合「做错的题」，同一题只留最近一次 */
router.get(
  '/wrong',
  wrap((req, res) => {
    const where = [];
    const params = [];
    if (req.query.level === 'cet4' || req.query.level === 'cet6') { where.push('p.level = ?'); params.push(req.query.level); }
    if (req.query.kind === 'reading' || req.query.kind === 'matching') { where.push('s.kind = ?'); params.push(req.query.kind); }
    const whereSql = where.length ? 'AND ' + where.join(' AND ') : '';

    const rows = db.query(
      `SELECT q.id AS question_id, q.seq, q.q_number, q.stem, q.answer,
              s.id AS set_id, s.kind, s.title, p.code, p.level, p.year, p.month, p.set_no,
              an.chosen, MAX(a.id) AS last_attempt,
              COUNT(*) AS wrong_times
         FROM exam_answers an
         JOIN exam_attempts a ON a.id = an.attempt_id
         JOIN exam_questions q ON q.id = an.question_id
         JOIN exam_sets s ON s.id = a.set_id
         JOIN exam_papers p ON p.id = s.paper_id
        WHERE an.correct = 0 ${whereSql}
        GROUP BY q.id
        ORDER BY wrong_times DESC, a.id DESC
        LIMIT 200`,
      params
    );

    res.json({ total: rows.length, items: rows });
  })
);

/** 清空做题记录 */
router.post(
  '/records/reset',
  wrap((req, res) => {
    const setId = int(req.body?.setId, 0, 0);
    db.transaction(() => {
      if (setId) {
        const ids = db.query('SELECT id FROM exam_attempts WHERE set_id = ?', [setId]).map((r) => r.id);
        for (const id of ids) db.execute('DELETE FROM exam_answers WHERE attempt_id = ?', [id]);
        db.execute('DELETE FROM exam_attempts WHERE set_id = ?', [setId]);
      } else {
        db.execute('DELETE FROM exam_answers');
        db.execute('DELETE FROM exam_attempts');
      }
    });
    res.json({ ok: true });
  })
);

module.exports = router;
