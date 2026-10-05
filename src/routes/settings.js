'use strict';

/** 设置、数据管理（重置 / 导出备份） */

const express = require('express');
const db = require('../db');
const { wrap, dayStr } = require('../util');

const router = express.Router();

const EDITABLE = new Set([
  'active_book', 'daily_new', 'daily_review', 'new_order', 'batch_size',
  'accent', 'auto_pronounce', 'theme', 'quiz_count', 'quiz_type',
  'show_phonetic', 'auto_next', 'leech_threshold',
]);

router.get(
  '/',
  wrap((req, res) => {
    const meta = db.query('SELECT key, value FROM meta');
    res.json({
      settings: db.getSettings(),
      meta: { ...Object.fromEntries(meta.map((m) => [m.key, m.value])), node: process.version },
      database: db.DB_FILE,
    });
  })
);

router.put(
  '/',
  wrap((req, res) => {
    const body = req.body || {};
    const changed = [];
    for (const [k, v] of Object.entries(body)) {
      if (!EDITABLE.has(k)) continue;
      db.setSetting(k, v);
      changed.push(k);
    }
    res.json({ updated: changed, settings: db.getSettings() });
  })
);

/**
 * 重置数据
 * body: { scope: 'progress' | 'logs' | 'all' }
 *   progress —— 清空学习进度与打卡
 *   logs     —— 只清空学习流水与统计
 *   all      —— 进度 + 流水 + 收藏 + 设置恢复默认（词库保留）
 */
router.post(
  '/reset',
  wrap((req, res) => {
    const scope = String(req.body?.scope || 'progress');

    db.transaction(() => {
      if (scope === 'logs') {
        db.execute('DELETE FROM logs');
        db.execute('DELETE FROM checkins');
      } else if (scope === 'all') {
        db.execute('DELETE FROM progress');
        db.execute('DELETE FROM logs');
        db.execute('DELETE FROM checkins');
        db.execute('DELETE FROM settings');
        const stmt = db.db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)');
        for (const [k, v] of Object.entries(db.DEFAULT_SETTINGS)) stmt.run(k, v);
      } else {
        db.execute('DELETE FROM progress');
        db.execute('DELETE FROM logs');
        db.execute('DELETE FROM checkins');
      }
    });

    res.json({ ok: true, scope, settings: db.getSettings() });
  })
);

/** 导出学习进度为 CSV（带 UTF-8 BOM，Excel 直接双击不乱码） */
router.get(
  '/export',
  wrap((req, res) => {
    const rows = db.query(`
      SELECT w.spelling, w.pos, w.meaning,
             COALESCE(p.status,'new') AS status, COALESCE(p.stage,0) AS stage,
             COALESCE(p.reps,0) AS reps,
             COALESCE(p.known_count,0) AS known_count,
             COALESCE(p.vague_count,0) AS vague_count,
             COALESCE(p.unknown_count,0) AS unknown_count,
             COALESCE(p.quiz_right,0) AS quiz_right,
             COALESCE(p.quiz_wrong,0) AS quiz_wrong,
             COALESCE(p.favorite,0) AS favorite,
             COALESCE(p.suspended,0) AS suspended,
             COALESCE(p.note,'') AS note,
             COALESCE(p.first_seen_at,'') AS first_seen_at,
             COALESCE(p.last_review_at,'') AS last_review_at,
             COALESCE(p.due_at,'') AS due_at
        FROM words w
        JOIN progress p ON p.word_id = w.id
       ORDER BY p.last_review_at DESC
    `);

    const header = [
      '单词', '词性', '释义', '学习状态', '记忆阶段', '过关次数',
      '认识次数', '模糊次数', '不认识次数', '测试答对', '测试答错',
      '收藏', '暂缓', '助记笔记', '首次学习', '最后复习', '下次复习',
    ];

    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.spelling, r.pos, r.meaning, r.status, r.stage, r.reps,
        r.known_count, r.vague_count, r.unknown_count, r.quiz_right, r.quiz_wrong,
        r.favorite ? '是' : '否', r.suspended ? '是' : '否', r.note,
        r.first_seen_at, r.last_review_at, r.due_at,
      ].map(esc).join(','));
    }

    const csv = '\uFEFF' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="wordmaster-progress-${dayStr()}.csv"`
    );
    res.send(csv);
  })
);

/** 学习记录明细导出 */
router.get(
  '/export/logs',
  wrap((req, res) => {
    const rows = db.query(`
      SELECT l.day, l.created_at, w.spelling, l.mode, l.rating, l.correct, l.book_code
        FROM logs l JOIN words w ON w.id = l.word_id
       ORDER BY l.id DESC
    `);

    /* 这个导出以前是直接 join(',') 的 —— 字段里一旦出现逗号或引号就会串列。
       单词拼写一般不会，但这些数据来自 OCR 清洗，不能假设它干净。 */
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = ['日期,时间,单词,模式,反馈,是否正确,词库'];
    for (const r of rows) {
      lines.push([
        r.day, r.created_at, r.spelling, r.mode, r.rating,
        r.correct ? '是' : '否', r.book_code,
      ].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="wordmaster-logs-${dayStr()}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  })
);

module.exports = router;
