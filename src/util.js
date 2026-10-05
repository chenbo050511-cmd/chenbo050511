'use strict';

/** 通用小工具：日期、进度落库、响应包装 */

const db = require('./db');

/** 本地时区的 YYYY-MM-DD */
function dayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 某天在本地的 00:00 对应的 ISO 时间 */
function dayStartIso(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

function todayStr() {
  return dayStr();
}

/** 整数参数解析，带边界保护 */
function int(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** 把 async 路由的异常统一交给 Express 错误中间件 */
function wrap(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

/* ------------------------------------------------------------------ */
/* 学习进度落库                                                        */
/* ------------------------------------------------------------------ */

const UPSERT_PROGRESS = `
  INSERT INTO progress(word_id, status, stage, due_at, last_rating, reps,
                       known_count, vague_count, unknown_count,
                       quiz_right, quiz_wrong, first_seen_at, last_review_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(word_id) DO UPDATE SET
    status        = excluded.status,
    stage         = excluded.stage,
    due_at        = excluded.due_at,
    last_rating   = excluded.last_rating,
    reps          = excluded.reps,
    known_count   = excluded.known_count,
    vague_count   = excluded.vague_count,
    unknown_count = excluded.unknown_count,
    quiz_right    = excluded.quiz_right,
    quiz_wrong    = excluded.quiz_wrong,
    last_review_at= excluded.last_review_at
`;

/**
 * 把 srs.schedule() 的结果写入 progress。
 * first_seen_at 只在首次学习时写入，之后保持不变。
 */
function saveProgress(wordId, rows) {
  const s = rows;
  const existing = db.queryOne('SELECT first_seen_at FROM progress WHERE word_id = ?', [wordId]);
  const firstSeen = existing?.first_seen_at || s.last_review_at;

  db.execute(UPSERT_PROGRESS, [
    wordId,
    s.status,
    s.stage,
    s.due_at,
    s.last_rating,
    s.reps,
    s.known_count,
    s.vague_count,
    s.unknown_count,
    s.quiz_right,
    s.quiz_wrong,
    firstSeen,
    s.last_review_at,
  ]);
  return firstSeen;
}

/** 写一条学习流水 + 更新打卡汇总 */
function logStudy({ wordId, bookCode = '', mode, rating = '', correct = 0, countStats = true }) {
  const day = todayStr();
  db.execute(
    `INSERT INTO logs(word_id, book_code, mode, rating, correct, day, created_at)
     VALUES(?,?,?,?,?,?,?)`,
    [wordId, bookCode, mode, rating, correct, day, new Date().toISOString()]
  );
  // 本轮重复的作答只留流水、不进打卡：正确率只该反映「第一次作答」
  if (!countStats) return;
  db.execute(
    `INSERT INTO checkins(day, learned, correct, wrong, new_words, seconds)
     VALUES(?, 1, ?, ?, 0, 0)
     ON CONFLICT(day) DO UPDATE SET
       learned = learned + 1,
       correct = correct + excluded.correct,
       wrong   = wrong + excluded.wrong`,
    [day, correct ? 1 : 0, correct ? 0 : 1]
  );
}

/**
 * 「错题」的统一判定：测试答错 **或** 翻卡时标记「不认识」。
 *
 * 错题本列表、侧边栏徽标、统计页的错题数必须都用这一条，否则会出现
 * 「列表里有 2 个、徽标只显示 1 个」这种自相矛盾（曾经就是这样：
 * 列表用 OR，另外两处只判断 quiz_wrong）。
 *
 * @param {string} p 表别名，例如 'p'
 */
function isMistake(p = '') {
  const q = p ? `${p}.` : '';
  // 「手动加入」也算错题 —— 做真题时点词收藏的词，要能在错题本里找到。
  // 相应地，/quiz/mistakes/clear 必须把这个标记一起清掉，否则删不掉。
  return `(${q}quiz_wrong > 0 OR ${q}unknown_count > 0 OR ${q}marked > 0)`;
}

/**
 * 「这个词还没开始学」的统一判定 —— 学新词队列必须用这一条。
 *
 * 不能只判断 `p.word_id IS NULL`（progress 里没有这一行）。
 * 因为 /words/:id/{favorite,mark,note,suspend} 都是「先建后改」：
 * 给一个还没学过的词加收藏 / 写笔记 / 暂缓，都会 `INSERT ... VALUES(?, 'new', 0, ...)`
 * 造出一行 progress。一旦只认 `IS NULL`，这个词就**多了一行、于是永远不算新词**，
 * 从此在「学新词」里彻底消失，再也背不到（而且用户完全看不出发生了什么）。
 *
 * 实测踩过：真实数据里出现过一个全零的 progress 行（加入错题本又移除留下的），
 * 它永久堵住了一个考研词。
 *
 * 所以判定要看**这一行到底学没学过**：status 还是 new、一次都没过关（reps=0）、
 * 也没有首次学习时间（first_seen_at IS NULL）。
 *
 * @param {string} p progress 表的别名，例如 'p'
 */
function isUntouched(p = 'p') {
  const q = p ? `${p}.` : '';
  return `(${q}word_id IS NULL
           OR (COALESCE(${q}status,'new') = 'new'
               AND COALESCE(${q}reps,0) = 0
               AND ${q}first_seen_at IS NULL))`;
}

/**
 * 「已经真正学过」的判定 —— 与 isUntouched() 互补。
 * 统计口径必须用它，否则那些只带标记的空行会被算进「累计学过」，
 * 而状态分布（learning/reviewing/mastered）又不算它们，两边永远对不上（实测差 1）。
 */
function isStarted(p = 'p') {
  const q = p ? `${p}.` : '';
  return `(${q}word_id IS NOT NULL
           AND (COALESCE(${q}status,'new') <> 'new'
                OR COALESCE(${q}reps,0) > 0
                OR ${q}first_seen_at IS NOT NULL))`;
}

/** 取某词当前进度（没有则构造一条初始的） */
function getProgress(wordId) {
  return db.queryOne('SELECT * FROM progress WHERE word_id = ?', [wordId]) || {
    word_id: wordId,
    status: 'new',
    stage: 0,
    reps: 0,
    known_count: 0,
    vague_count: 0,
    unknown_count: 0,
    quiz_right: 0,
    quiz_wrong: 0,
    favorite: 0,
    due_at: null,
  };
}

/**
 * 带学习统计的词库列表（books 路由和 study 路由共用，避免两处 SQL 走偏）。
 * 传 code 则只返回该词库；返回的每一项都带上 total/started/mastered/due/unit_count/percent。
 *
 * 三处口径都必须和别处一致（否则就会出现「浏览页说还有 3518 个新词、
 * 学新词队列却只给 3517 个」这种自相矛盾）：
 *  - `started` / `mastered` 用 isStarted()：**只带标记的空行不算学过**
 *    （给未学的词写笔记/收藏/暂缓时会建出这种行）
 *  - `due` 用 isStarted() 且排除已暂缓
 */
function loadBooks(code) {
  const now = new Date().toISOString();
  const params = [now];
  let where = '';
  if (code) {
    where = 'WHERE b.code = ?';
    params.push(code);
  }

  return db
    .query(
      `SELECT b.id, b.code, b.name, b.short_name, b.description, b.accent, b.sort_order,
              (SELECT COUNT(*) FROM book_words bw WHERE bw.book_id = b.id) AS total,
              (SELECT COUNT(*) FROM book_words bw JOIN progress p ON p.word_id = bw.word_id
                WHERE bw.book_id = b.id AND ${isStarted('p')}) AS started,
              (SELECT COUNT(*) FROM book_words bw JOIN progress p ON p.word_id = bw.word_id
                WHERE bw.book_id = b.id AND p.status = 'mastered' AND ${isStarted('p')}) AS mastered,
              (SELECT COUNT(*) FROM book_words bw JOIN progress p ON p.word_id = bw.word_id
                WHERE bw.book_id = b.id AND p.due_at IS NOT NULL AND p.due_at <= ?
                  AND COALESCE(p.suspended,0) = 0) AS due,
              (SELECT COUNT(*) FROM units u WHERE u.book_id = b.id) AS unit_count
         FROM books b
         ${where}
        ORDER BY b.sort_order`,
      params
    )
    .map((b) => ({ ...b, percent: b.total ? Math.round((b.started / b.total) * 100) : 0 }));
}

/** 连续打卡天数（从今天或昨天往前推） */
function streak() {
  const days = db
    .query('SELECT day FROM checkins WHERE learned > 0 ORDER BY day DESC LIMIT 400')
    .map((r) => r.day);
  if (!days.length) return { current: 0, best: 0 };

  const set = new Set(days);
  const cursor = new Date();
  // 今天还没学不算断签，从昨天开始算
  if (!set.has(dayStr(cursor))) cursor.setDate(cursor.getDate() - 1);

  let current = 0;
  while (set.has(dayStr(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // 历史最长
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    if (prev) {
      const p = new Date(prev + 'T00:00:00');
      p.setDate(p.getDate() + 1);
      run = dayStr(p) === d ? run + 1 : 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    prev = d;
  }

  return { current, best };
}

module.exports = {
  dayStr,
  dayStartIso,
  todayStr,
  int,
  wrap,
  saveProgress,
  logStudy,
  getProgress,
  isMistake,
  isUntouched,
  isStarted,
  loadBooks,
  streak,
};
