'use strict';
/*
 * 数据库快照：**WAL 感知**的备份。
 *
 * 为什么需要它（踩过的坑）：
 *   这个项目的数据库跑在 WAL 模式下，最近的写入可能还留在 `-wal` 文件里，
 *   **没有合并进主库文件**。所以 `fs.copyFileSync(db, db + '.bak')` 这种
 *   只复制主库文件的写法，拿到的可能是**旧数据**。
 *
 *   实测过：修完 31 处真题文本后只用 copyFileSync 备份，
 *   副本里那些修复「不存在」—— 因为它们还在 WAL 里。
 *   更危险的是反向情况：以为备份保住了某个状态，实际没有。
 *
 *   项目自己的 README 就提醒过「连同 WAL/SHM 一起复制才是完整状态」，
 *   但代码里的每个备份点都没做到（clean-exam-text.py / repair-exam-text.js /
 *   check-migration.js / run-tests.js / pack.js）。
 *
 * 做法：
 *   先 `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 合并进主库（让备份更干净），
 *   然后**永远把 db + -wal + -shm 三个文件一起复制**。
 *
 *   为什么即使 checkpoint 成功了也还是复制三个文件：
 *   本工具可能被用在**服务正在跑**的时候，此时删掉 -wal / -shm 是危险的
 *   （另一个连接可能正要写）。备份工具绝不该冒损坏数据库的风险，
 *   所以这里只做「复制」，不做任何删除。
 */

const fs = require('node:fs');

/**
 * 把 WAL 合并进主库文件。成功返回 true。
 *
 * 注意：**即使返回 false 也不影响快照的完整性** —— 快照会把 -wal 一起复制。
 * 这一步只是让备份更干净（主库文件自身即完整），不是正确性的前提。
 */
function checkpoint(dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  let db;
  try {
    /* 延迟 require：node:sqlite 是实验性 API，避免在不需要时触发告警 */
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    return true;
  } catch {
    try { if (db) db.close(); } catch { /* 忽略 */ }
    return false;
  }
}

/**
 * 给数据库做一个完整快照。
 *
 * @param {string} dbPath 数据库主文件路径
 * @param {string} dest   备份目标路径
 * @returns {{mode: string, files: string[]}}
 */
function snapshot(dbPath, dest) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`数据库不存在：${dbPath}`);
  }

  const merged = checkpoint(dbPath);

  /* 无论 checkpoint 是否成功，都把三个文件一起复制 —— 这是唯一无条件安全的做法 */
  const files = [];
  for (const s of ['', '-wal', '-shm']) {
    const src = dbPath + s;
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, dest + s);
    files.push(dest + s);
  }
  if (!files.length) throw new Error(`数据库不存在：${dbPath}`);

  return { mode: merged ? 'merged+triple' : 'triple', files };
}

/** 快照是否完整（用于校验，不修改任何东西） */
function validate(dbPath) {
  const hasWal = fs.existsSync(dbPath + '-wal');
  const walSize = hasWal ? fs.statSync(dbPath + '-wal').size : 0;
  return {
    exists: fs.existsSync(dbPath),
    hasWal,
    /* WAL 非空 = 主库文件本身不是完整状态，必须一起备份 */
    needsWal: hasWal && walSize > 0,
    walSize,
  };
}

module.exports = { snapshot, checkpoint, validate };
