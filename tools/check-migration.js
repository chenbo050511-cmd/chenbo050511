'use strict';
/*
 * 回归测试：P0「恢复出厂设置 → 重启后二次迁移压 stage」
 *
 * 复现路径（原来的 bug）：
 *   1. 库已有 6 档格式的进度（stage 0..5）
 *   2. 用户点「恢复出厂设置」→ 老代码 `DELETE FROM settings` 顺手删掉了 srs_v2 标记
 *   3. 重启服务 → migrateOnce('srs_v2') 再跑一遍 → 把 0..5 当旧 10 档再平移
 *      → stage 5(60天) 被压成 stage 1(3天)，而 due_at 不动
 *
 * 本脚本在**临时副本**上做，绝不碰 data/wordmaster.db：
 *   副本 A：模拟旧库（标记在 settings 老位置）→ 验证迁移不重复执行
 *   副本 B：模拟「已被重置过、数据已是新格式但标记丢失」→ 验证按数据内容跳过
 *   副本 C：模拟真正的旧格式数据（存在 stage >= 6）→ 验证迁移**仍然会执行**
 *
 * 用法：node tools/check-migration.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'wordmaster.db');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-migrate-'));

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  [ok]   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

/** 复制一份库（连同 WAL/SHM，才是完整状态） */
function copyDb(name) {
  const dest = path.join(TMP, name);
  for (const suffix of ['', '-wal', '-shm']) {
    const from = SRC_DB + suffix;
    if (fs.existsSync(from)) fs.copyFileSync(from, dest + suffix);
  }
  return dest;
}

/** 在一个子进程里加载 src/db.js（会触发建表 + 迁移），返回它的结果 */
function bootDb(dbPath) {
  const { execFileSync } = require('node:child_process');
  const script = `
    const db = require(${JSON.stringify(path.join(ROOT, 'src', 'db.js'))});
    const rows = db.query('SELECT stage, COUNT(*) AS c FROM progress GROUP BY stage ORDER BY stage');
    const marker = db.queryOne("SELECT value FROM meta WHERE key = 'migration:srs_v2'");
    const legacy = db.queryOne("SELECT value FROM settings WHERE key = 'srs_v2'");
    const stages = db.query('SELECT word_id, stage FROM progress ORDER BY word_id');
    const settings = db.getSettings();
    console.log(JSON.stringify({
      rows, marker: marker ? marker.value : null,
      legacy: legacy ? legacy.value : null,
      stages, hasSrsKey: Object.prototype.hasOwnProperty.call(settings, 'srs_v2'),
    }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, WM_DB: dbPath },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim().split('\n').pop());
}

function raw(dbPath, fn) {
  const d = new DatabaseSync(dbPath);
  try { return fn(d); } finally { d.close(); }
}

console.log('回归测试：恢复出厂设置后的二次迁移\n');

/* ------------------------------------------------------------------ */
/* 场景 A：老库（标记还在 settings 老位置）—— 必须不重复迁移              */
/* ------------------------------------------------------------------ */
console.log('A) 老库：标记在 settings 老位置');
{
  const db = copyDb('a.db');
  // 造一个「已迁移过」的状态：stage 都是新格式 0..5，标记在老位置
  raw(db, (d) => {
    d.exec("DELETE FROM meta WHERE key = 'migration:srs_v2'");
    d.exec("DELETE FROM settings WHERE key = 'srs_v2'");
    d.exec("INSERT OR REPLACE INTO settings(key,value) VALUES('srs_v2','1')");
    d.exec('DELETE FROM progress');
    d.exec(`INSERT INTO progress(word_id,status,stage,reps,first_seen_at)
            VALUES (1,'learning',0,3,'2026-01-01T00:00:00Z'),
                   (2,'reviewing',3,5,'2026-01-01T00:00:00Z'),
                   (3,'reviewing',5,9,'2026-01-01T00:00:00Z')`);
  });
  const r = bootDb(db);
  const s = Object.fromEntries(r.stages.map((x) => [x.word_id, x.stage]));
  ok(s[1] === 0 && s[2] === 3 && s[3] === 5, 'stage 原样保留（没被再压一遍）',
    `实际 ${JSON.stringify(s)}`);
  ok(r.marker === '1', '标记已提升到 meta.migration:srs_v2');
  ok(r.legacy === null, 'settings 里的老标记已被清掉');
  ok(r.hasSrsKey === false, 'getSettings() 不再下发 srs_v2');
}

/* ------------------------------------------------------------------ */
/* 场景 B：这个 bug 的真实残留状态 —— 重置过、数据新格式、标记丢失        */
/* ------------------------------------------------------------------ */
console.log('\nB) 已被重置过（标记丢失），但数据已是新格式 —— 必须跳过');
{
  const db = copyDb('b.db');
  raw(db, (d) => {
    // 精确复现「老代码 reset scope=all 之后」的状态：
    //   settings 被清空（srs_v2 没了）、meta 里也没有新标记、progress 是新格式
    d.exec("DELETE FROM settings WHERE key = 'srs_v2'");
    d.exec("DELETE FROM meta WHERE key = 'migration:srs_v2'");
    d.exec('DELETE FROM progress');
    d.exec(`INSERT INTO progress(word_id,status,stage,reps,first_seen_at)
            VALUES (1,'learning',0,1,'2026-01-01T00:00:00Z'),
                   (2,'reviewing',2,4,'2026-01-01T00:00:00Z'),
                   (3,'reviewing',5,9,'2026-01-01T00:00:00Z')`);
  });
  const r = bootDb(db);
  const s = Object.fromEntries(r.stages.map((x) => [x.word_id, x.stage]));
  ok(s[3] === 5, '★ 关键：stage5 没有被压成 stage1（这正是原来的 bug）',
    `实际 ${JSON.stringify(s)}`);
  ok(s[1] === 0 && s[2] === 2, '其余 stage 也原样保留');
  ok(r.marker === null, '标记没被打上（留给真正需要时再跑）',
    `marker=${r.marker}`);
}

/* ------------------------------------------------------------------ */
/* 场景 C：真正的旧格式数据（存在 stage >= 6）—— 迁移必须仍然执行         */
/* ------------------------------------------------------------------ */
console.log('\nC) 真正的旧格式（存在 stage >= 6）—— 必须执行迁移');
{
  const db = copyDb('c.db');
  raw(db, (d) => {
    d.exec("DELETE FROM settings WHERE key = 'srs_v2'");
    d.exec("DELETE FROM meta WHERE key = 'migration:srs_v2'");
    d.exec('DELETE FROM progress');
    // 旧 10 档：0=5分 3=1天 6=7天 8=30天 9=60天
    d.exec(`INSERT INTO progress(word_id,status,stage,reps,first_seen_at)
            VALUES (1,'learning',0,1,'2026-01-01T00:00:00Z'),
                   (2,'reviewing',3,2,'2026-01-01T00:00:00Z'),
                   (3,'reviewing',6,3,'2026-01-01T00:00:00Z'),
                   (4,'reviewing',8,4,'2026-01-01T00:00:00Z'),
                   (5,'mastered',9,9,'2026-01-01T00:00:00Z')`);
  });
  const r = bootDb(db);
  const s = Object.fromEntries(r.stages.map((x) => [x.word_id, x.stage]));
  // 期望：0→0, 3→0, 6→2, 8→4, 9→5
  ok(s[1] === 0 && s[2] === 0, '旧 0/3 档 → 新 0 档（1 天）', JSON.stringify(s));
  ok(s[3] === 2, '旧 6 档（7天）→ 新 2 档（7 天）');
  ok(s[4] === 4, '旧 8 档（30天）→ 新 4 档（30 天）');
  ok(s[5] === 5, '旧 9 档（60天）→ 新 5 档（60 天）');
  ok(r.marker === '1', '迁移执行后打了标记');
}

/* ------------------------------------------------------------------ */
/* 场景 D：迁移后再重启 —— 必须不变（幂等）                              */
/* ------------------------------------------------------------------ */
console.log('\nD) 幂等：同一份库连续启动两次，结果必须一致');
{
  const db = copyDb('d.db');
  raw(db, (d) => {
    d.exec("DELETE FROM settings WHERE key = 'srs_v2'");
    d.exec("DELETE FROM meta WHERE key = 'migration:srs_v2'");
    d.exec('DELETE FROM progress');
    d.exec(`INSERT INTO progress(word_id,status,stage,reps,first_seen_at)
            VALUES (1,'mastered',9,9,'2026-01-01T00:00:00Z')`);
  });
  const first = bootDb(db);
  const second = bootDb(db);
  const third = bootDb(db);
  const f = first.stages.map((x) => x.stage).join(',');
  const s = second.stages.map((x) => x.stage).join(',');
  const t = third.stages.map((x) => x.stage).join(',');
  ok(f === s && s === t, '三次启动结果完全一致（不会每次都压一遍）',
    `第一次=${f} 第二次=${s} 第三次=${t}`);
  ok(f === '5', 'stage 9 → 5 且此后不变');
}

/* ------------------------------------------------------------------ */
/* 场景 E：真实数据（只读副本）—— 现状核对                                */
/* ------------------------------------------------------------------ */
console.log('\nE) 你的真实数据（只读副本）');
{
  const db = copyDb('e.db');
  raw(db, (d) => {
    // 只读探查：当前标记位置与 stage 分布
    const legacy = d.prepare("SELECT value FROM settings WHERE key='srs_v2'").get();
    console.log(`  settings.srs_v2 = ${legacy ? JSON.stringify(legacy.value) : '（无）'}`);
    const dist = d.prepare('SELECT stage, COUNT(*) c FROM progress GROUP BY stage ORDER BY stage').all();
    console.log('  当前 stage 分布: ' + dist.map((x) => `${x.stage}→${x.c}`).join(', '));
  });
  const r = bootDb(db);
  const dist = r.rows.map((x) => `${x.stage}→${x.c}`).join(', ');
  const before = raw(db, (d) => d.prepare('SELECT stage FROM progress ORDER BY word_id').all().map((x) => x.stage).join(','));
  console.log(`  启动一次后 stage 分布: ${dist}`);
  ok(r.marker === '1' || r.marker === null, '启动不报错');
  ok(r.legacy === null, '老标记已被提升、settings 里不再有 srs_v2');
  const maxStage = Math.max(...r.stages.map((x) => x.stage));
  ok(maxStage <= 5, '★ 没有任何 stage 超出新格式的 0..5（数据没被压坏）', `maxStage=${maxStage}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'='.repeat(54)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`${'='.repeat(54)}\n`);
process.exit(fail ? 1 : 0);
