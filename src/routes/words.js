'use strict';

/** 单词列表 / 详情 / 收藏 —— 「词库」页的分类浏览与搜索 */

const express = require('express');
const db = require('../db');
const srs = require('../srs');
const { wrap, int, isUntouched } = require('../util');

const router = express.Router();

/** 笔记长度上限（字符）—— 助记是给自己看的短句，不需要长篇 */
const NOTE_MAX = 500;

/** 学习状态筛选条件 → SQL 片段 */
const STATUS_SQL = {
  all: '1=1',
  // 「未学」必须用 isUntouched()，不能只看 status='new' ——
  // 给未学的词写笔记/收藏/暂缓会建出一行 status='new' 的 progress，
  // 只判 status 的话这个筛选会把它算成「已学」，和「学新词」队列矛盾。
  new: isUntouched('p'),
  learning: "p.status = 'learning'",
  reviewing: "p.status = 'reviewing'",
  mastered: "p.status = 'mastered'",
  // 到期筛选同样要排除已暂缓的词 —— 否则「浏览」里显示待复习、
  // 复习队列里却没有它（暂缓的定义就是不排进队列）
  due: 'p.due_at IS NOT NULL AND p.due_at <= ? AND COALESCE(p.suspended,0) = 0',
  favorite: 'p.favorite = 1',
  // 顽固词：暂缓待处理的难词
  suspended: 'COALESCE(p.suspended,0) = 1',
};

const SORTS = {
  freq: 'bw.sort_order ASC',
  alpha: 'w.lower ASC',
  length: 'w.length ASC, w.lower ASC',
  due: 'p.due_at ASC NULLS LAST',
  wrong: 'p.quiz_wrong DESC, p.unknown_count DESC',
};

/** 列表查询：支持 词库 / 单元 / 首字母 / 词性 / 状态 / 关键词 六种筛选 */
router.get(
  '/',
  wrap((req, res) => {
    const bookCode = String(req.query.book || 'cet4');
    const book = db.queryOne('SELECT id, code, name FROM books WHERE code = ?', [bookCode]);
    if (!book) return res.status(404).json({ error: '词库不存在' });

    const unitId = req.query.unit ? int(req.query.unit, 0) : 0;
    const letter = String(req.query.letter || '').trim().toUpperCase();
    const pos = String(req.query.pos || '').trim();
    const status = String(req.query.status || 'all');
    const q = String(req.query.q || '').trim();
    const page = int(req.query.page, 1, 1, 100000);
    const size = int(req.query.size, 50, 1, 200);
    const sortKey = SORTS[req.query.sort] ? req.query.sort : 'freq';

    const where = ['bw.book_id = ?'];
    const params = [book.id];
    const now = new Date().toISOString();

    if (unitId) { where.push('bw.unit_id = ?'); params.push(unitId); }
    if (letter && letter !== 'ALL') { where.push('w.letter = ?'); params.push(letter); }
    if (pos) { where.push("(' ' || w.pos || ' ') LIKE ?"); params.push(`% ${pos} %`); }
    if (q) { where.push('(w.lower LIKE ? OR w.meaning LIKE ?)'); params.push(`%${q.toLowerCase()}%`, `%${q}%`); }

    const statusSql = STATUS_SQL[status];
    if (statusSql) {
      where.push(`(${statusSql})`);
      if (status === 'due') params.push(now);
    }

    const whereSql = where.join(' AND ');

    const total = db.queryOne(
      `SELECT COUNT(*) AS c
         FROM book_words bw
         JOIN words w ON w.id = bw.word_id
         LEFT JOIN progress p ON p.word_id = w.id
        WHERE ${whereSql}`,
      params
    ).c;

    const items = db.query(
      `SELECT w.id, w.spelling, w.phonetic, w.pos, w.meaning, w.meaning_alt, w.definition,
              w.exchange, w.collins, w.oxford, w.bnc, w.frq, w.letter, w.length,
              bw.unit_id, u.name AS unit_name,
              COALESCE(p.status,'new') AS status, p.stage, p.due_at, p.reps,
              COALESCE(p.favorite,0) AS favorite,
              COALESCE(p.quiz_right,0) AS quiz_right, COALESCE(p.quiz_wrong,0) AS quiz_wrong,
              COALESCE(p.suspended,0) AS suspended,
              CASE WHEN COALESCE(p.note,'') <> '' THEN 1 ELSE 0 END AS has_note
         FROM book_words bw
         JOIN words w ON w.id = bw.word_id
         LEFT JOIN units u ON u.id = bw.unit_id
         LEFT JOIN progress p ON p.word_id = w.id
        WHERE ${whereSql}
        ORDER BY ${SORTS[sortKey]}
        LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size]
    );

    res.json({
      book,
      total,
      page,
      size,
      pages: Math.max(1, Math.ceil(total / size)),
      items,
    });
  })
);

/** 随机抽词（用于「随便看看」/ 空状态占位）—— 必须放在 /:id 之前，否则会被当成 id */
router.get(
  '/random/pick',
  wrap((req, res) => {
    const bookCode = String(req.query.book || 'cet4');
    const count = int(req.query.count, 5, 1, 50);
    const items = db.query(
      `SELECT w.id, w.spelling, w.phonetic, w.pos, w.meaning
         FROM book_words bw
         JOIN words w ON w.id = bw.word_id
         JOIN books b ON b.id = bw.book_id
        WHERE b.code = ?
        ORDER BY RANDOM() LIMIT ?`,
      [bookCode, count]
    );
    res.json(items);
  })
);

/**
 * 把真题里点到的词形还原成词典词条。
 *
 * 真题正文里出现的是 conditions / studies / Married 这类形式，
 * 词典里存的是原形，所以直接查会查不到 —— 先试原样，再按常见词形变化回落。
 */
const FORM_FALLBACK = [
  [/ies$/, 'y'], [/ied$/, 'y'], [/ying$/, 'ie'],
  [/es$/, ''], [/s$/, ''],
  [/ing$/, ''], [/ing$/, 'e'],
  [/ed$/, ''], [/ed$/, 'e'], [/d$/, ''],
  [/er$/, ''], [/est$/, ''],
];

function resolveWord(token) {
  const w = String(token || '').trim().toLowerCase();
  if (!w || w.length < 2 || !/^[a-z][a-z'-]*$/.test(w)) return null;

  const direct = db.queryOne('SELECT * FROM words WHERE lower = ?', [w]);
  if (direct) return direct;

  for (const [re, rep] of FORM_FALLBACK) {
    const cand = w.replace(re, rep);
    if (cand.length < 3 || cand === w) continue;
    const hit = db.queryOne('SELECT * FROM words WHERE lower = ?', [cand]);
    if (hit) return hit;
  }
  return null;
}

/** 查词：做真题时点单词用。必须放在 `/:id` 之前，否则会被它抢走 */
router.get(
  '/lookup',
  wrap((req, res) => {
    const token = String(req.query.word || '');
    const hit = resolveWord(token);

    // 词库里没有（不是四级词）→ 退回查词专用扩展表
    if (!hit) {
      const token2 = String(token).trim();
      let extra = token2 && /^[a-z][a-z'-]*$/i.test(token2)
        ? db.queryOne('SELECT * FROM dict_extra WHERE lower = ?', [token2.toLowerCase()])
        : null;
      if (!extra) {
        for (const [re, rep] of FORM_FALLBACK) {
          const cand = token2.toLowerCase().replace(re, rep);
          if (cand.length < 3 || cand === token2.toLowerCase()) continue;
          extra = db.queryOne('SELECT * FROM dict_extra WHERE lower = ?', [cand]);
          if (extra) break;
        }
      }
      if (!extra) return res.json({ found: false, token });

      return res.json({
        found: true,
        token,
        source: 'extra',
        word: {
          id: null,                        // 不在词库里，没有学习进度可谈
          spelling: extra.word,
          phonetic: extra.phonetic,
          pos: extra.pos,
          meaning: extra.meaning,
          meaning_alt: '',
          exchange: extra.exchange,
          collins: 0,
          oxford: 0,
        },
        phrases: [],
        marked: false,
        favorite: false,
      });
    }

    const phrases = db
      .query('SELECT phrase FROM word_phrases WHERE word_id = ? ORDER BY seq LIMIT 4', [hit.id])
      .map((r) => r.phrase);
    const p = db.queryOne('SELECT marked, favorite FROM progress WHERE word_id = ?', [hit.id]);

    res.json({
      found: true,
      token,
      source: 'book',
      folded: hit.spelling.toLowerCase() !== String(token).trim().toLowerCase(),
      word: {
        id: hit.id,
        spelling: hit.spelling,
        phonetic: hit.phonetic,
        pos: hit.pos,
        meaning: hit.meaning,
        meaning_alt: hit.meaning_alt,
        exchange: hit.exchange,
        collins: hit.collins,
        oxford: hit.oxford,
      },
      phrases,
      marked: !!(p && p.marked),
      favorite: !!(p && p.favorite),
    });
  })
);

/** 单词详情：含所有所属词库 + 学习进度 */
router.get(
  '/:id',
  wrap((req, res) => {
    const id = int(req.params.id, 0, 1);
    const word = db.queryOne('SELECT * FROM words WHERE id = ?', [id]);
    if (!word) return res.status(404).json({ error: '单词不存在' });

    const books = db.query(
      `SELECT b.code, b.short_name, u.name AS unit_name, bw.sort_order
         FROM book_words bw
         JOIN books b ON b.id = bw.book_id
         LEFT JOIN units u ON u.id = bw.unit_id
        WHERE bw.word_id = ?
        ORDER BY b.sort_order`,
      [id]
    );

    const progress = db.queryOne('SELECT * FROM progress WHERE word_id = ?', [id]);
    const recent = db.query(
      `SELECT mode, rating, correct, day, created_at FROM logs
        WHERE word_id = ? ORDER BY id DESC LIMIT 20`,
      [id]
    );

    res.json({ word, books, progress, recent, maxStage: srs.MAX_STAGE });
  })
);

/**
 * 保存助记笔记。
 *
 * 笔记存在 progress 上，所以给还没学过的词写笔记会**顺带建一条 progress 记录**
 * （status 保持 'new'、stage 0，不影响排期 —— 和「收藏」「手动加入错题本」同一个做法）。
 * 传空字符串就是删除笔记。
 */
router.post(
  '/:id/note',
  wrap((req, res) => {
    const id = int(req.params.id, 0, 1);
    const exists = db.queryOne('SELECT 1 AS x FROM words WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: '单词不存在' });

    const raw = req.body?.note;
    if (raw !== undefined && typeof raw !== 'string') {
      return res.status(400).json({ error: 'note 必须是字符串' });
    }
    const note = String(raw ?? '').trim().slice(0, NOTE_MAX);

    db.execute(
      `INSERT INTO progress(word_id, status, stage, note)
       VALUES(?, 'new', 0, ?)
       ON CONFLICT(word_id) DO UPDATE SET note = excluded.note`,
      [id, note]
    );
    res.json({ wordId: id, note, saved: note.length > 0 });
  })
);

/**
 * 手动加入 / 移出错题本。
 *
 * 错题本的判定是 `isMistake()`（测试答错 或 翻卡不认识 或 **手动加入**），
 * 所以这里只动 marked 标记。**不要动 stage / status / due_at** ——
 * 错题本是一份「难词清单」，进出它不该打乱复习排期。
 */
router.post(
  '/:id/mark',
  wrap((req, res) => {
    const id = int(req.params.id, 0, 1);
    const exists = db.queryOne('SELECT 1 AS x FROM words WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: '单词不存在' });

    const current = db.queryOne('SELECT marked FROM progress WHERE word_id = ?', [id]);
    const want = req.body?.marked === undefined ? null : (req.body.marked ? 1 : 0);
    const next = want === null ? (current?.marked ? 0 : 1) : want;

    db.execute(
      `INSERT INTO progress(word_id, status, stage, marked)
       VALUES(?, 'new', 0, ?)
       ON CONFLICT(word_id) DO UPDATE SET marked = excluded.marked`,
      [id, next]
    );
    res.json({ wordId: id, marked: next });
  })
);

/** 收藏 / 取消收藏 */
router.post(
  '/:id/favorite',
  wrap((req, res) => {
    const id = int(req.params.id, 0, 1);
    const exists = db.queryOne('SELECT 1 AS x FROM words WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: '单词不存在' });

    const want = req.body?.favorite === undefined ? null : (req.body.favorite ? 1 : 0);
    const current = db.queryOne('SELECT favorite FROM progress WHERE word_id = ?', [id]);
    const next = want === null ? (current?.favorite ? 0 : 1) : want;

    db.execute(
      `INSERT INTO progress(word_id, status, stage, favorite)
       VALUES(?, 'new', 0, ?)
       ON CONFLICT(word_id) DO UPDATE SET favorite = excluded.favorite`,
      [id, next]
    );
    res.json({ wordId: id, favorite: next });
  })
);

/**
 * 暂缓 / 恢复一个词（顽固词处理）。
 *
 * 背景（对标 Anki 的 leech 机制，见 https://docs.ankiweb.net/leeches.html）：
 * Anki 会把反复失败的卡打上 leech 标记并**暂停**，理由很直白 ——
 * 这类卡占用你远多于其他卡的时间。而 WordMaster 原来的做法恰好相反：
 * 复习队列按「错误次数×权重」把老是错的词排到**最前面**，于是它们每次必来，
 * 无限占用时间。这里给出出口：暂缓后不再进复习队列，但保留全部记录、随时可恢复。
 *
 * 只动 suspended，**不动 stage / status / due_at** ——
 * 恢复之后复习节奏跟暂缓前一模一样。
 */
router.post(
  '/:id/suspend',
  wrap((req, res) => {
    const id = int(req.params.id, 0, 1);
    const exists = db.queryOne('SELECT 1 AS x FROM words WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: '单词不存在' });

    const want = req.body?.suspended === undefined ? null : (req.body.suspended ? 1 : 0);
    const current = db.queryOne('SELECT suspended FROM progress WHERE word_id = ?', [id]);
    const next = want === null ? (current?.suspended ? 0 : 1) : want;

    db.execute(
      `INSERT INTO progress(word_id, status, stage, suspended)
       VALUES(?, 'new', 0, ?)
       ON CONFLICT(word_id) DO UPDATE SET suspended = excluded.suspended`,
      [id, next]
    );
    res.json({ wordId: id, suspended: next });
  })
);

/** 重置单个单词的学习进度（词库浏览页的「重置进度」用） */
router.post(
  '/:id/reset',
  wrap((req, res) => {
    const id = int(req.params.id, 0, 1);
    const exists = db.queryOne('SELECT 1 AS x FROM words WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: '单词不存在' });

    db.transaction(() => {
      db.execute('DELETE FROM progress WHERE word_id = ?', [id]);
      db.execute('DELETE FROM logs WHERE word_id = ?', [id]);
    });
    res.json({ ok: true, wordId: id });
  })
);

/** 随机抽词见上方 /random/pick（必须位于 /:id 之前） */

module.exports = router;
