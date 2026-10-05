'use strict';

/** 词库与单元：分类浏览的一级/二级入口 */

const express = require('express');
const db = require('../db');
const { wrap, loadBooks } = require('../util');

const router = express.Router();

/** 词库列表，附带每个词库的学习进度 */
router.get(
  '/',
  wrap((req, res) => {
    res.json(loadBooks());
  })
);

/** 单个词库详情 + 单元列表 */
router.get(
  '/:code/units',
  wrap((req, res) => {
    const { code } = req.params;
    const book = db.queryOne('SELECT * FROM books WHERE code = ?', [code]);
    if (!book) return res.status(404).json({ error: '词库不存在' });

    const units = db.query(
      `SELECT u.id, u.name, u.seq,
              (SELECT COUNT(*) FROM book_words bw WHERE bw.unit_id = u.id) AS total,
              (SELECT COUNT(*) FROM book_words bw JOIN progress p ON p.word_id = bw.word_id
                WHERE bw.unit_id = u.id) AS started,
              (SELECT COUNT(*) FROM book_words bw JOIN progress p ON p.word_id = bw.word_id
                WHERE bw.unit_id = u.id AND p.status = 'mastered') AS mastered
       FROM units u
       WHERE u.book_id = ?
       ORDER BY u.seq`,
      [book.id]
    );

    res.json({
      book,
      units: units.map((u) => ({
        ...u,
        percent: u.total ? Math.round((u.started / u.total) * 100) : 0,
      })),
    });
  })
);

/** 首字母分布，用于「按字母分类」筛选器 */
router.get(
  '/:code/letters',
  wrap((req, res) => {
    const book = db.queryOne('SELECT id FROM books WHERE code = ?', [req.params.code]);
    if (!book) return res.status(404).json({ error: '词库不存在' });

    const rows = db.query(
      `SELECT w.letter AS letter, COUNT(*) AS total,
              SUM(CASE WHEN p.word_id IS NOT NULL THEN 1 ELSE 0 END) AS started
       FROM book_words bw
       JOIN words w ON w.id = bw.word_id
       LEFT JOIN progress p ON p.word_id = w.id
       WHERE bw.book_id = ?
       GROUP BY w.letter
       ORDER BY w.letter`,
      [book.id]
    );
    res.json(rows);
  })
);

/** 词性分布，用于「按词性分类」筛选器 */
router.get(
  '/:code/pos',
  wrap((req, res) => {
    const book = db.queryOne('SELECT id FROM books WHERE code = ?', [req.params.code]);
    if (!book) return res.status(404).json({ error: '词库不存在' });

    const rows = db.query(
      `SELECT w.pos FROM book_words bw JOIN words w ON w.id = bw.word_id
       WHERE bw.book_id = ? AND w.pos <> ''`,
      [book.id]
    );

    const counter = new Map();
    for (const r of rows) {
      for (const p of r.pos.split(/\s+/)) {
        if (p) counter.set(p, (counter.get(p) || 0) + 1);
      }
    }
    const order = ['n.', 'v.', 'adj.', 'adv.', 'prep.', 'conj.', 'pron.', 'num.', 'int.', 'aux.', 'abbr.', 'pl.'];
    res.json(
      [...counter.entries()]
        .map(([pos, total]) => ({ pos, total }))
        .sort((a, b) => {
          const ia = order.indexOf(a.pos);
          const ib = order.indexOf(b.pos);
          if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
          return b.total - a.total;
        })
    );
  })
);

module.exports = router;
