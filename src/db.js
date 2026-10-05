'use strict';

/**
 * 数据层：使用 Node 内置的 node:sqlite（Node >= 22.5），无需任何原生编译依赖。
 * 只对外暴露 query / queryOne / execute / transaction 四个helper，
 * 所有 SQL 都用位置占位符 `?`，参数统一经 normalize() 处理
 * （node:sqlite 不接受 undefined / boolean）。
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
/**
 * WM_DB 可以把数据库指到别处。
 * 主要用途：在数据库副本上做验证（尤其是有写操作的功能），不要拿真实数据当试验田。
 *   WM_DB=D:/tmp/copy.db PORT=3999 node server.js
 */
const DB_FILE = process.env.WM_DB
  ? path.resolve(process.env.WM_DB)
  : path.join(DATA_DIR, 'wordmaster.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
`);

/** 把 JS 值转成 node:sqlite 能接受的绑定值 */
function normalize(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function query(sql, params = []) {
  return db.prepare(sql).all(...params.map(normalize));
}

function queryOne(sql, params = []) {
  const row = db.prepare(sql).get(...params.map(normalize));
  return row === undefined ? null : row;
}

function execute(sql, params = []) {
  return db.prepare(sql).run(...params.map(normalize));
}

/** node:sqlite 没有内置事务封装，这里手动包一层 */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 建表                                                                */
/* ------------------------------------------------------------------ */

const SCHEMA = `
-- 词库（分类一级：四级 / 六级 / 考研）
CREATE TABLE IF NOT EXISTS books (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  short_name  TEXT    NOT NULL,
  description TEXT    DEFAULT '',
  accent      TEXT    DEFAULT '#6366f1',
  total       INTEGER DEFAULT 0,
  sort_order  INTEGER DEFAULT 0
);

-- 单元（分类二级：按词频分批的 Unit，或字母分组）
CREATE TABLE IF NOT EXISTS units (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  word_count INTEGER DEFAULT 0,
  UNIQUE (book_id, seq)
);

-- 单词主表（全局去重，一个词只存一条）
CREATE TABLE IF NOT EXISTS words (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  spelling     TEXT    NOT NULL UNIQUE,
  lower        TEXT    NOT NULL,
  phonetic     TEXT    DEFAULT '',
  pos          TEXT    DEFAULT '',
  meaning      TEXT    NOT NULL,
  meaning_alt  TEXT    DEFAULT '',
  definition   TEXT    DEFAULT '',
  exchange     TEXT    DEFAULT '',
  collins      INTEGER DEFAULT 0,
  oxford       INTEGER DEFAULT 0,
  brook        INTEGER DEFAULT 0,   -- 保留位：是否英式核心词
  bnc          INTEGER DEFAULT 0,
  frq          INTEGER DEFAULT 0,
  tags         TEXT    DEFAULT '',
  letter       TEXT    DEFAULT '',
  length       INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_words_lower  ON words(lower);
CREATE INDEX IF NOT EXISTS idx_words_letter ON words(letter);
CREATE INDEX IF NOT EXISTS idx_words_frq    ON words(frq);

-- 常见搭配：从**真题语料**里抽出来的「这个词在真题里怎么用」。
-- 本地词典没有搭配数据，而真题正文正是这些词的真实用武之地（实测已学词 97% 都能找到）。
-- 由 tools/build-phrases.js 生成，允许为空。
CREATE TABLE IF NOT EXISTS word_phrases (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  phrase  TEXT    NOT NULL,
  hits    INTEGER DEFAULT 0,        -- 在大语料里出现的次数
  pmi     REAL    DEFAULT 0,        -- 搭配强度（越大结合越紧）
  example TEXT    DEFAULT '',       -- 含该词的真题原句（只有第一条存）
  seq     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_word_phrases ON word_phrases(word_id, seq);

-- 查词用的扩展词表。
-- 背单词的词库只有 6158 个四级/六级/考研词，而做真题阅读时点词查义，
-- 正文里 81% 的词查不到（连 study / people / because 都没有）。
-- 所以单独建一张**只用于查词**的表：从完整 ECDICT 取常见词（约 2.7 万条）。
-- **不并进 words** —— 那是背单词的词库，混进 the / because 会污染学习列表。
-- 由 tools/build-extra-dict.py 生成。
CREATE TABLE IF NOT EXISTS dict_extra (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  word     TEXT NOT NULL,
  lower    TEXT NOT NULL,
  phonetic TEXT DEFAULT '',
  pos      TEXT DEFAULT '',
  meaning  TEXT DEFAULT '',
  exchange TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_dict_extra_lower ON dict_extra(lower);

-- 单词 ↔ 词库 多对多（同一个词可同时属于四级和考研）
CREATE TABLE IF NOT EXISTS book_words (
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  word_id    INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  unit_id    INTEGER REFERENCES units(id) ON DELETE SET NULL,
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (book_id, word_id)
);
CREATE INDEX IF NOT EXISTS idx_bw_word ON book_words(word_id);
CREATE INDEX IF NOT EXISTS idx_bw_unit ON book_words(unit_id);

-- 学习进度（按单词维度，跨词库共享）
CREATE TABLE IF NOT EXISTS progress (
  word_id       INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
  status        TEXT    NOT NULL DEFAULT 'new',  -- new | learning | reviewing | mastered
  stage         INTEGER NOT NULL DEFAULT 0,      -- 艾宾浩斯阶段 0..9
  due_at        TEXT,                            -- 下次复习时间 (ISO8601)
  last_rating   TEXT,                            -- known | vague | unknown
  reps          INTEGER DEFAULT 0,               -- 总复习次数
  known_count   INTEGER DEFAULT 0,
  vague_count   INTEGER DEFAULT 0,
  unknown_count INTEGER DEFAULT 0,
  quiz_right    INTEGER DEFAULT 0,
  quiz_wrong    INTEGER DEFAULT 0,
  favorite      INTEGER DEFAULT 0,
  first_seen_at TEXT,
  last_review_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_progress_due    ON progress(due_at);
CREATE INDEX IF NOT EXISTS idx_progress_status ON progress(status);

-- 学习流水（统计用）
CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id    INTEGER NOT NULL,
  book_code  TEXT    DEFAULT '',
  mode       TEXT    NOT NULL,   -- card | quiz
  rating     TEXT    DEFAULT '', -- known | vague | unknown | right | wrong
  correct    INTEGER DEFAULT 0,
  day        TEXT    NOT NULL,   -- YYYY-MM-DD，便于按天聚合
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_day  ON logs(day);
CREATE INDEX IF NOT EXISTS idx_logs_word ON logs(word_id);

-- 每日打卡（汇总，避免每次统计都扫 logs）
CREATE TABLE IF NOT EXISTS checkins (
  day       TEXT PRIMARY KEY,
  learned   INTEGER DEFAULT 0,
  correct   INTEGER DEFAULT 0,
  wrong     INTEGER DEFAULT 0,
  new_words INTEGER DEFAULT 0,
  seconds   INTEGER DEFAULT 0
);

-- 设置项
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 元信息（词库版本、构建时间等）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

/* ------------------------------------------------------------------ */
/* 真题题库（短文阅读 / 段落匹配）                                      */
/* ------------------------------------------------------------------ */

-- 试卷：一次考试的一套题
CREATE TABLE IF NOT EXISTS exam_papers (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT    NOT NULL UNIQUE,   -- 2019-06-CET4-1
  level  TEXT    NOT NULL,          -- cet4 | cet6
  year   INTEGER NOT NULL,
  month  INTEGER NOT NULL,
  set_no INTEGER NOT NULL,
  title  TEXT    NOT NULL,
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_exam_papers_level ON exam_papers(level, year DESC, month DESC);

-- 题目组：一篇文章 + 它后面的一组题
CREATE TABLE IF NOT EXISTS exam_sets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id      INTEGER NOT NULL REFERENCES exam_papers(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,   -- reading | matching
  seq           INTEGER NOT NULL,
  title         TEXT    DEFAULT '',
  instructions  TEXT    DEFAULT '',
  passage       TEXT    NOT NULL,
  word_count    INTEGER DEFAULT 0,
  question_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_exam_sets_kind ON exam_sets(kind);

-- 段落（只有段落匹配用得到）
CREATE TABLE IF NOT EXISTS exam_paragraphs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES exam_sets(id) ON DELETE CASCADE,
  label  TEXT    NOT NULL,
  text   TEXT    NOT NULL,
  seq    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_para_set ON exam_paragraphs(set_id, seq);

-- 题目：阅读是四选一，匹配是「选段落字母」
CREATE TABLE IF NOT EXISTS exam_questions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id   INTEGER NOT NULL REFERENCES exam_sets(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  q_number INTEGER DEFAULT 0,      -- 原卷题号，例如 46
  stem     TEXT    NOT NULL,
  answer   TEXT    NOT NULL,
  explanation TEXT DEFAULT ''      -- 真题自带解析（定位依据 + 逐项排除理由）
);
CREATE INDEX IF NOT EXISTS idx_exam_q_set ON exam_questions(set_id, seq);

CREATE TABLE IF NOT EXISTS exam_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  seq         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_opt_q ON exam_options(question_id, seq);

-- 阅读短文的段落。
-- 源题库的正文是一整块（没有换行），分段是从真题 PDF 里按「首行缩进」还原出来的，
-- 所以这里允许为空 —— 取不到分段时前端回退成整段显示。
CREATE TABLE IF NOT EXISTS exam_reading_paragraphs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES exam_sets(id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,
  text   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_rpara_set ON exam_reading_paragraphs(set_id, seq);

-- 做题记录
CREATE TABLE IF NOT EXISTS exam_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id      INTEGER NOT NULL REFERENCES exam_sets(id) ON DELETE CASCADE,
  total       INTEGER NOT NULL,
  right_count INTEGER NOT NULL,
  wrong_count INTEGER NOT NULL,
  duration_ms INTEGER DEFAULT 0,
  day         TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_attempt_day ON exam_attempts(day);
CREATE INDEX IF NOT EXISTS idx_exam_attempt_set ON exam_attempts(set_id);

-- 每道题的作答明细（错题回顾用）
CREATE TABLE IF NOT EXISTS exam_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id  INTEGER NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL,
  chosen      TEXT    DEFAULT '',
  correct     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_ans_attempt ON exam_answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_exam_ans_q ON exam_answers(question_id);
`;

db.exec(SCHEMA);

/* ------------------------------------------------------------------ */
/* 轻量迁移：给已有的库补上后加的列                                     */
/* ------------------------------------------------------------------ */

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// 真题解析是后加的，老库需要补列（不能只靠 CREATE TABLE IF NOT EXISTS）
ensureColumn('exam_questions', 'explanation', "explanation TEXT DEFAULT ''");
// 搭配强度是后加的，老库要补列
ensureColumn('word_phrases', 'pmi', 'pmi REAL DEFAULT 0');
// 「手动加入错题本」是后加的：做真题时点词收藏用的
ensureColumn('progress', 'marked', 'marked INTEGER DEFAULT 0');
// 用户自己写的助记笔记（谐音 / 词根 / 场景联想）—— 这是最有效的记忆手段之一，
// 而且完全离线、零依赖，跟这个项目的定位一致
ensureColumn('progress', 'note', "note TEXT DEFAULT ''");
// 顽固词（leech）：老是记不住的词可以「暂缓」，不再每天来占用时间。
// 与 Anki 的 leech/suspend 是同一个思路（见 docs.ankiweb.net/leeches.html）。
ensureColumn('progress', 'suspended', 'suspended INTEGER DEFAULT 0');

/* ------------------------------------------------------------------ */
/* 一次性数据迁移                                                      */
/* ------------------------------------------------------------------ */

/** 跑一次就记个标记，之后不再重复执行 */
function migrateOnce(key, fn) {
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (done) return;
  fn();
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').run(key, '1');
}

/*
 * 排期模型从「10 档（含 5 分/30 分/12 小时）」换成「6 档日粒度（1/3/7/15/30/60 天）」，
 * 已有进度的阶段号要按「间隔最接近」平移过来，**due_at 保持不动** ——
 * 不动到期时间，用户当前的复习节奏就不会被打乱。
 */
migrateOnce('srs_v2', () => {
  db.exec(`
    UPDATE progress SET stage = CASE
      WHEN stage <= 3 THEN 0     -- 旧 5分 / 30分 / 12时 / 1天  → 新「1 天」
      WHEN stage <= 5 THEN 1     -- 旧 2天 / 4天                → 新「3 天」
      WHEN stage = 6  THEN 2     -- 旧 7天                     → 新「7 天」
      WHEN stage = 7  THEN 3     -- 旧 15天                    → 新「15 天」
      WHEN stage = 8  THEN 4     -- 旧 30天                    → 新「30 天」
      ELSE 5                     -- 旧 60天                    → 新「60 天」
    END
  `);
});

/* ------------------------------------------------------------------ */
/* 默认设置                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  active_book: 'cet4',      // 当前选中的词库
  daily_new: '20',          // 每日新词量
  daily_review: '120',      // 每日复习上限
  new_order: 'freq',        // 新词顺序：freq(高频优先) | alpha(字母序)
  batch_size: '5',          // 学新词时一批几个（一批全部过关才进下一批）
  accent: 'us',             // 发音口音：us | uk
  auto_pronounce: '1',      // 卡片翻面自动发音
  theme: 'dark',            // dark | light
  quiz_count: '10',         // 每轮测试题量
  quiz_type: 'mix',         // en2cn | cn2en | mix
  show_phonetic: '1',
  auto_next: '1',           // 答对后自动下一题
  /*
   * 顽固词（leech）判定阈值：累计错误次数达到多少就提示「该处理一下了」。
   * 对标 Anki 的 leech 机制（默认失败 8 次打标并暂停，见 docs.ankiweb.net/leeches.html），
   * 理由很直白：这类词占用你远多于其他词的时间。
   * 这里用「测试答错 + 翻卡不认识」的累计次数，默认 6（比 Anki 略低，
   * 因为词库只有 6000 词、每词重复机会比 Anki 的卡组少）。
   */
  leech_threshold: '6'
};

function ensureDefaults() {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) stmt.run(k, v);
}
ensureDefaults();

function getSettings() {
  const rows = query('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  execute(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

module.exports = {
  db,
  DB_FILE,
  DATA_DIR,
  ROOT,
  query,
  queryOne,
  execute,
  transaction,
  getSettings,
  setSetting,
  DEFAULT_SETTINGS,
};
