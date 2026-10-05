'use strict';

/** 统计：总览、每日曲线、热力图、未来复习负载预测 */

const express = require('express');
const db = require('../db');
const srs = require('../srs');
const { wrap, int, dayStr, streak, isMistake } = require('../util');

const router = express.Router();

/** 总览数字 */
router.get(
  '/overview',
  wrap((req, res) => {
    const now = new Date().toISOString();

    // wrong_words 必须和错题本列表用同一套判定，否则卡片数字和列表条数对不上
    const g = db.queryOne(`
      SELECT
        (SELECT COUNT(*) FROM words) AS word_total,
        (SELECT COUNT(*) FROM progress) AS started,
        (SELECT COUNT(*) FROM progress WHERE status = 'learning') AS learning,
        (SELECT COUNT(*) FROM progress WHERE status = 'reviewing') AS reviewing,
        (SELECT COUNT(*) FROM progress WHERE status = 'mastered') AS mastered,
        (SELECT COUNT(*) FROM progress WHERE favorite = 1) AS favorite,
        (SELECT COUNT(*) FROM progress WHERE due_at IS NOT NULL AND due_at <= ?
           AND COALESCE(suspended,0) = 0) AS due_now,
        (SELECT COUNT(*) FROM progress WHERE COALESCE(suspended,0) = 1) AS suspended,
        (SELECT COUNT(*) FROM progress WHERE ${isMistake()}) AS wrong_words
    `, [now]);

    // 正确率只统计第一次作答（card = 翻卡首答，quiz = 测试）。
    // card_repeat（本轮重复）与 card_done（过关归档）不计入，否则反复重来会把正确率拉高
    const agg = db.queryOne(`
      SELECT COUNT(*) AS reviews,
             COALESCE(SUM(correct),0) AS right,
             COALESCE(SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END),0) AS wrong
        FROM logs
       WHERE mode IN ('card','quiz')
    `);

    const studyDays = db.queryOne('SELECT COUNT(*) AS c FROM checkins WHERE learned > 0').c;
    const seconds = db.queryOne('SELECT COALESCE(SUM(seconds),0) AS s FROM checkins').s;

    res.json({
      ...g,
      notStarted: g.word_total - g.started,
      percent: g.word_total ? Math.round((g.started / g.word_total) * 100) : 0,
      totalReviews: agg.reviews,
      accuracy: agg.reviews ? Math.round((agg.right / agg.reviews) * 100) : 0,
      studyDays,
      minutes: Math.round(seconds / 60),
      streak: streak(),
    });
  })
);

/** 每日学习曲线（按本地日期聚合） */
router.get(
  '/daily',
  wrap((req, res) => {
    const days = int(req.query.days, 30, 1, 400);

    const rows = db.query(`
      SELECT l.day,
             COUNT(*) AS learned,
             COALESCE(SUM(l.correct),0) AS right_count,
             COALESCE(SUM(CASE WHEN l.correct = 0 THEN 1 ELSE 0 END),0) AS wrong_count,
             SUM(CASE WHEN l.mode = 'card' THEN 1 ELSE 0 END) AS card_count,
             SUM(CASE WHEN l.mode = 'quiz' THEN 1 ELSE 0 END) AS quiz_count
        FROM logs l
       GROUP BY l.day
       ORDER BY l.day
    `);

    // 新词数：首次学习发生在当天的词。
    // 注意 first_seen_at 存的是 UTC ISO，直接 substr 切出来的日期在东八区会错，
    // 所以取回后在 JS 里按本地时区归日。
    const firstSeenRows = db.query(
      'SELECT first_seen_at FROM progress WHERE first_seen_at IS NOT NULL'
    );
    const firstMap = new Map();
    for (const r of firstSeenRows) {
      const d = dayStr(new Date(r.first_seen_at));
      firstMap.set(d, (firstMap.get(d) || 0) + 1);
    }

    const seconds = db.query('SELECT day, seconds FROM checkins');
    const secMap = new Map(seconds.map((r) => [r.day, r.seconds]));

    const map = new Map(rows.map((r) => [r.day, r]));
    const out = [];
    const cursor = new Date();
    cursor.setDate(cursor.getDate() - (days - 1));

    for (let i = 0; i < days; i++) {
      const d = dayStr(cursor);
      const r = map.get(d);
      out.push({
        day: d,
        learned: r ? r.learned : 0,
        newWords: firstMap.get(d) || 0,
        right: r ? r.right_count : 0,
        wrong: r ? r.wrong_count : 0,
        card: r ? r.card_count : 0,
        quiz: r ? r.quiz_count : 0,
        seconds: secMap.get(d) || 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    const max = Math.max(1, ...out.map((d) => d.learned));
    const totals = out.reduce(
      (acc, d) => ({
        learned: acc.learned + d.learned,
        newWords: acc.newWords + d.newWords,
        right: acc.right + d.right,
        wrong: acc.wrong + d.wrong,
      }),
      { learned: 0, newWords: 0, right: 0, wrong: 0 }
    );

    res.json({ days, max, totals, items: out });
  })
);

/** 热力图（默认最近半年） */
router.get(
  '/heatmap',
  wrap((req, res) => {
    const days = int(req.query.days, 182, 7, 400);
    const rows = db.query('SELECT day, learned FROM checkins WHERE learned > 0');
    const map = new Map(rows.map((r) => [r.day, r.learned]));

    const cursor = new Date();
    cursor.setDate(cursor.getDate() - (days - 1));

    const items = [];
    for (let i = 0; i < days; i++) {
      const d = dayStr(cursor);
      items.push({ day: d, learned: map.get(d) || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    const max = Math.max(1, ...items.map((i) => i.learned));
    res.json({ days, max, items });
  })
);

/** 未来 N 天的复习负载预测（本地日期分桶） */
router.get(
  '/load',
  wrap((req, res) => {
    const days = int(req.query.days, 7, 1, 60);
    const rows = db.query('SELECT due_at FROM progress WHERE due_at IS NOT NULL');

    const today = dayStr();
    const bucket = new Map();
    let overdue = 0;
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    end.setDate(end.getDate() + days - 1);

    for (const r of rows) {
      const d = new Date(r.due_at);
      const key = dayStr(d);
      if (key < today) overdue++;
      else if (d <= end) bucket.set(key, (bucket.get(key) || 0) + 1);
    }

    const out = [];
    const cursor = new Date();
    for (let i = 0; i < days; i++) {
      const d = dayStr(cursor);
      out.push({ day: d, due: bucket.get(d) || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    res.json({ overdue, days, items: out, max: Math.max(1, ...out.map((i) => i.due)) });
  })
);

/**
 * 掌握程度分布（按艾宾浩斯阶段）
 *
 * 阶段数、标签、颜色档位全部由 src/srs.js 推导后下发，
 * 前端不再自己维护一份间隔表 —— 那份副本一旦没跟上排期改动，
 * 统计页就会显示错误的间隔（曾经把「1 天」显示成「5 分钟」）。
 */
router.get(
  '/stages',
  wrap((req, res) => {
    const rows = db.query('SELECT stage, COUNT(*) AS c FROM progress GROUP BY stage');
    const map = new Map(rows.map((r) => [r.stage, r.c]));

    const labels = srs.stageLabels();
    // 「已掌握」的判定与 src/srs.js 的 statusOf() 保持一致：stage >= 4 记为 mastered
    const items = labels.map((label, i) => ({
      stage: i,
      label,
      count: map.get(i) || 0,
      mastered: i >= 4,
    }));

    // 颜色档位也一起给：低阶段是「刚起步」（琥珀），中段蓝色，
    // 接近封顶的用绿色 —— 与「已掌握」的语义对齐
    const colorOf = (i) => (i <= 1 ? 'warn' : i <= 3 ? 'info' : 'ok');

    const statusRows = db.query("SELECT status, COUNT(*) AS c FROM progress GROUP BY status");
    const statusMap = new Map(statusRows.map((r) => [r.status, r.c]));

    res.json({
      items,
      labels,
      maxStage: srs.MAX_STAGE,
      intervals: srs.INTERVALS,
      colorOf: items.map((_, i) => colorOf(i)),
      status: {
        new: db.queryOne('SELECT COUNT(*) AS c FROM words').c - db.queryOne('SELECT COUNT(*) AS c FROM progress').c,
        learning: statusMap.get('learning') || 0,
        reviewing: statusMap.get('reviewing') || 0,
        mastered: statusMap.get('mastered') || 0,
      },
    });
  })
);

/** 每个词库的完成度对比 */
router.get(
  '/books',
  wrap((req, res) => {
    const now = new Date().toISOString();
    res.json(
      db.query(
        `SELECT b.code, b.short_name, b.accent,
                COUNT(bw.word_id) AS total,
                SUM(CASE WHEN p.word_id IS NOT NULL THEN 1 ELSE 0 END) AS started,
                SUM(CASE WHEN p.status = 'mastered' THEN 1 ELSE 0 END) AS mastered,
                SUM(CASE WHEN p.due_at IS NOT NULL AND p.due_at <= ? THEN 1 ELSE 0 END) AS due
           FROM books b
           JOIN book_words bw ON bw.book_id = b.id
           LEFT JOIN progress p ON p.word_id = bw.word_id
          GROUP BY b.id
          ORDER BY b.sort_order`,
        [now]
      )
    );
  })
);

module.exports = router;
