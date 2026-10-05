'use strict';

/**
 * 从 ECDICT 原始词典（tools/_raw/ecdict.csv，77 万词条）构建本应用的词库。
 *
 * 做四件事：
 *   1. 按 ECDICT 的 tag 字段抽取 四级(cet4) / 六级(cet6) / 考研(ky) 三个词表
 *   2. 清洗数据：拆分释义行、剥离专业领域标记、统一音标符号、解析词形变化
 *   3. 全局去重（同一个词可能同时属于四级和考研，只存一条，用中间表关联）
 *   4. 按词频从高到低排序，每 50 词切一个 Unit —— 保证先背高频词
 *
 * 用法：
 *   node tools/build-dict.js           # 已有词库时拒绝重建
 *   node tools/build-dict.js --force   # 强制重建（会清空学习进度）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const db = require('../src/db');

const RAW_DIR = path.join(__dirname, '_raw');
/*
 * 优先用精简词典。
 * 全量 ECDICT 有 77 万行、62.9MB，但本应用只用到带 cet4/cet6/ky 标签的 6161 行，
 * 精简成 1.66MB 后结果完全一样（已验证词表数量一致）。
 * 精简文件不存在时才退回全量 CSV。
 */
const SLIM = path.join(RAW_DIR, 'ecdict-slim.csv');
const FULL = path.join(RAW_DIR, 'ecdict.csv');
const RAW = fs.existsSync(SLIM) ? SLIM : FULL;
const FORCE = process.argv.includes('--force');
const UNIT_SIZE = 50;

/* ------------------------------------------------------------------ */
/* 词库定义                                                            */
/* ------------------------------------------------------------------ */

const BOOKS = [
  {
    code: 'cet4',
    name: '大学英语四级核心词汇',
    short_name: 'CET-4',
    tag: 'cet4',
    accent: '#4f7cff',
    description: '四级考试高频词表，按词频从高到低排列，先啃最常考的。',
    sort_order: 1,
  },
  {
    code: 'cet6',
    name: '大学英语六级核心词汇',
    short_name: 'CET-6',
    tag: 'cet6',
    accent: '#8b5cf6',
    description: '六级难度词汇，含大量四级已覆盖词，进度与四级共享。',
    sort_order: 2,
  },
  {
    code: 'kaoyan',
    name: '考研英语核心词汇',
    short_name: '考研',
    tag: 'ky',
    accent: '#ec4899',
    description: '考研英语大纲核心词，熟词僻义较多，释义分行展示。',
    sort_order: 3,
  },
];

/* ------------------------------------------------------------------ */
/* CSV 解析（支持引号包裹与 "" 转义）                                   */
/* ------------------------------------------------------------------ */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuote = false;
      } else field += c;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 字段清洗                                                            */
/* ------------------------------------------------------------------ */

/** ECDICT 的释义用字面量 \n 分行，专业领域释义用 [医] [经] 这类标记开头 */
const DOMAIN_LINE = /^\s*\[[^\]]*\]/;

const POS_ALIAS = {
  n: 'n.', v: 'v.', vt: 'v.', vi: 'v.', a: 'adj.', adj: 'adj.',
  adv: 'adv.', prep: 'prep.', conj: 'conj.', pron: 'pron.',
  num: 'num.', art: 'art.', int: 'int.', interj: 'int.', aux: 'aux.',
  abbr: 'abbr.', pl: 'pl.', u: 'n.', c: 'n.',
};

const POS_RE = /^([a-zA-Z]{1,5})\.\s*/;

function cleanMeaning(raw) {
  const lines = String(raw || '')
    .split('\\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const main = [];
  const domain = [];
  const posSet = [];

  for (const line of lines) {
    const isDomain = DOMAIN_LINE.test(line);
    const body = isDomain ? line.replace(DOMAIN_LINE, '').trim() : line;
    if (!body) continue;

    // 提取词性标记并归一化
    const m = body.match(POS_RE);
    if (m) {
      const canon = POS_ALIAS[m[1].toLowerCase()];
      if (canon && !posSet.includes(canon)) posSet.push(canon);
    }
    (isDomain ? domain : main).push(body);
  }

  // 如果所有释义都带领域标记，退而求其次用领域释义
  const useLines = main.length ? main : domain;
  return {
    meaning: useLines.join('；'),
    meaning_alt: main.length ? domain.join('；') : '',
    pos: posSet.join(' '),
  };
}

/** ECDICT 音标用的是类 ASCII 符号，转成规范 IPA 显示更专业 */
function cleanPhonetic(raw) {
  const p = String(raw || '').trim();
  if (!p) return '';
  return p
    .replace(/ә/g, 'ə')   // 西里尔字母 schwa → IPA
    .replace(/ɡ/g, 'g')
    .replace(/:/g, 'ː')   // 长音
    .replace(/'/g, 'ˈ')   // 主重音
    .replace(/,/g, 'ˌ')   // 次重音
    .replace(/\s+/g, ' ')
    .trim();
}

const EXCHANGE_MAP = {
  p: '过去式', d: '过去分词', i: '现在分词', '3': '第三人称单数',
  s: '复数', r: '比较级', t: '最高级', 0: '原形', 1: '原形变化',
};

function cleanExchange(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s
    .split('/')
    .map((part) => {
      const [k, ...rest] = part.split(':');
      const v = rest.join(':');
      if (!v) return '';
      const label = EXCHANGE_MAP[k];
      return label ? `${label}: ${v}` : '';
    })
    .filter(Boolean)
    .join(' · ');
}

function cleanDefinition(raw) {
  return String(raw || '')
    .split('\\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('; ');
}

const num = (v) => {
  const n = parseInt(String(v || '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------------ */
/* 词条筛选                                                            */
/* ------------------------------------------------------------------ */

const WORD_SHAPE = /^[a-zA-Z][a-zA-Z'’-]*$/;

function isValidWord(spelling, meaning) {
  if (!spelling || !meaning) return false;
  if (spelling.length < 2 || spelling.length > 28) return false;
  if (!WORD_SHAPE.test(spelling)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  if (!fs.existsSync(RAW)) {
    console.error('\n找不到词典数据。');
    console.error('正常情况下应存在精简词典：tools/_raw/ecdict-slim.csv （1.7MB）');
    console.error('如果连它也没有，就从 ECDICT 全量词典自己抽一份（需要先下载 62.9MB）：');
    console.error('  curl -L -o tools/_raw/ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv');
    console.error('  node tools/make-slim-dict.js\n');
    process.exit(1);
  }
  console.log(`使用词典数据：${path.basename(RAW)}`);

  const existing = db.queryOne('SELECT COUNT(*) AS c FROM words');
  if (existing.c > 0 && !FORCE) {
    console.log(`\n词库已存在（${existing.c} 个单词），跳过构建。`);
    console.log('如需重建请加 --force 参数（注意：会清空全部学习进度）。\n');
    return;
  }

  const t0 = Date.now();
  console.log('\n读取原始词典 ...');
  const text = fs.readFileSync(RAW, 'utf8');
  console.log(`  文件大小 ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(1)} MB`);

  const rows = parseCsv(text);
  const head = rows[0];
  const idx = {};
  head.forEach((h, i) => (idx[h.trim()] = i));
  console.log(`  解析出 ${rows.length - 1} 条词条`);

  // ---------- 第一步：抽取三个词表的成员 ----------
  const membership = new Map();  // spelling -> { word 数据, books: Set<code> }
  const tagSets = BOOKS.map((b) => ({ book: b, set: new Set() }));

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 3) continue;

    const tags = String(row[idx.tag] || '').trim();
    if (!tags) continue;

    const hit = tagSets.filter((t) => tags.split(/\s+/).includes(t.book.tag));
    if (!hit.length) continue;

    const spelling = String(row[idx.word] || '').trim();
    const rawMeaning = row[idx.translation] || '';
    const cleaned = cleanMeaning(rawMeaning);
    if (!isValidWord(spelling, cleaned.meaning)) continue;

    let entry = membership.get(spelling);
    if (!entry) {
      entry = {
        spelling,
        lower: spelling.toLowerCase(),
        phonetic: cleanPhonetic(row[idx.phonetic]),
        definition: cleanDefinition(row[idx.definition]),
        exchange: cleanExchange(row[idx.exchange]),
        collins: num(row[idx.collins]),
        oxford: num(row[idx.oxford]),
        bnc: num(row[idx.bnc]),
        frq: num(row[idx.frq]),
        tags,
        letter: spelling[0].toUpperCase(),
        length: spelling.length,
        meaning: cleaned.meaning,
        meaning_alt: cleaned.meaning_alt,
        pos: cleaned.pos,
        books: new Set(),
      };
      membership.set(spelling, entry);
    }
    hit.forEach((t) => {
      t.set.add(spelling);
      entry.books.add(t.book.code);
    });
  }

  console.log('\n各词库统计：');
  for (const t of tagSets) console.log(`  ${t.book.short_name.padEnd(6)} ${t.set.size} 词`);
  console.log(`  去重后合计 ${membership.size} 词`);

  // ---------- 第二步：写入数据库 ----------
  console.log('\n写入数据库 ...');
  const checksum = crypto.createHash('md5').update(text).digest('hex').slice(0, 12);

  db.transaction(() => {
    db.execute('DELETE FROM book_words');
    db.execute('DELETE FROM units');
    db.execute('DELETE FROM words');
    db.execute('DELETE FROM books');
    db.execute('DELETE FROM progress');
    db.execute('DELETE FROM logs');
    db.execute('DELETE FROM checkins');
    db.execute("DELETE FROM sqlite_sequence WHERE name IN ('words','units','books')");

    // 词库
    const bookIds = {};
    for (const b of BOOKS) {
      const res = db.execute(
        `INSERT INTO books(code, name, short_name, description, accent, sort_order)
         VALUES(?,?,?,?,?,?)`,
        [b.code, b.name, b.short_name, b.description, b.accent, b.sort_order]
      );
      bookIds[b.code] = Number(res.lastInsertRowid);
    }

    // 单词主表
    const wordStmt = db.db.prepare(
      `INSERT INTO words(spelling, lower, phonetic, pos, meaning, meaning_alt, definition,
                         exchange, collins, oxford, bnc, frq, tags, letter, length)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    // 排序：词频高的排前面（frq 为 0 表示无词频数据，推到最后）
    const entries = [...membership.values()].sort((a, b) => {
      const fa = a.frq || 999999;
      const fb = b.frq || 999999;
      if (fa !== fb) return fa - fb;
      if (a.collins !== b.collins) return b.collins - a.collins;
      return a.spelling.localeCompare(b.spelling);
    });

    const wordIds = new Map();
    for (const e of entries) {
      const res = wordStmt.run(
        e.spelling, e.lower, e.phonetic, e.pos, e.meaning, e.meaning_alt, e.definition,
        e.exchange, e.collins, e.oxford, e.bnc, e.frq, e.tags, e.letter, e.length
      );
      wordIds.set(e.spelling, Number(res.lastInsertRowid));
    }

    // 单元切分 + 关联
    const unitStmt = db.db.prepare('INSERT INTO units(book_id, name, seq, word_count) VALUES(?,?,?,?)');
    const bwStmt = db.db.prepare('INSERT OR IGNORE INTO book_words(book_id, word_id, unit_id, sort_order) VALUES(?,?,?,?)');
    const bookTotalStmt = db.db.prepare('UPDATE books SET total = ? WHERE id = ?');

    for (const t of tagSets) {
      const bookId = bookIds[t.book.code];
      // 词库内部同样按主表顺序（词频）排列，保证 Unit 01 是最高频的 50 个词
      const list = entries.filter((e) => t.set.has(e.spelling));
      const unitIds = new Map();  // seq -> unit_id

      for (let i = 0; i < list.length; i++) {
        const seq = Math.floor(i / UNIT_SIZE) + 1;
        let unitId = unitIds.get(seq);
        if (!unitId) {
          const res = unitStmt.run(bookId, `Unit ${String(seq).padStart(2, '0')}`, seq, 0);
          unitId = Number(res.lastInsertRowid);
          unitIds.set(seq, unitId);
        }
        bwStmt.run(bookId, wordIds.get(list[i].spelling), unitId, i + 1);
      }

      // 回填每个单元的真实词数
      db.execute(
        `UPDATE units SET word_count = (
           SELECT COUNT(*) FROM book_words WHERE book_words.unit_id = units.id
         ) WHERE book_id = ?`,
        [bookId]
      );
      bookTotalStmt.run(list.length, bookId);
    }

    db.execute('INSERT OR REPLACE INTO meta(key, value) VALUES(?,?)', ['dict_source', 'ECDICT (skywind3000)']);
    db.execute('INSERT OR REPLACE INTO meta(key, value) VALUES(?,?)', ['dict_checksum', checksum]);
    db.execute('INSERT OR REPLACE INTO meta(key, value) VALUES(?,?)', ['built_at', new Date().toISOString()]);
    db.execute('INSERT OR REPLACE INTO meta(key, value) VALUES(?,?)', ['word_total', String(membership.size)]);
  });

  // ---------- 校验 ----------
  const verify = db.query(`
    SELECT b.short_name, b.total,
           (SELECT COUNT(*) FROM book_words WHERE book_id = b.id) AS linked,
           (SELECT COUNT(*) FROM units WHERE book_id = b.id) AS units
    FROM books b ORDER BY b.sort_order
  `);
  console.log('\n构建结果：');
  for (const v of verify) {
    console.log(`  ${v.short_name.padEnd(6)} 词数 ${String(v.total).padStart(5)}  关联 ${String(v.linked).padStart(5)}  单元 ${v.units} 个`);
  }
  const sample = db.query('SELECT spelling, pos, meaning FROM words LIMIT 3');
  console.log('\n抽样检查：');
  for (const s of sample) console.log(`  ${s.spelling}  [${s.pos}]  ${s.meaning.slice(0, 60)}`);

  console.log(`\n完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒。`);
  console.log(`数据库：${db.DB_FILE}\n`);
}

main();
