'use strict';

/**
 * 打一个「零下载」的部署包。
 *
 * 背景：第一次部署慢，是因为启动脚本要去 GitHub 下 62.9MB 的全量词典。
 * 但其实**建好的数据库 data/wordmaster.db（5.6MB）里什么都有** ——
 * 6158 个单词、164 组真题、741 条解析、70 组分好的段落，全在里面。
 * 把数据库一起带走，目标机器上就一个字节都不用下。
 *
 * 打包内容（约 12MB）：
 *   源代码 + 前端 + 启动脚本 + 依赖 + 建好的数据库 + 重建用的精简数据
 * 排除：
 *   tools/_raw/exam/pdf（21MB）和 answerkey（6.8MB）—— 只在「重新推导分段/核对答案」时要，
 *   结果已经写进数据库了，日常部署不需要
 *
 * 用法：node tools/pack.js [输出目录]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));

const INCLUDE_FILES = [
  'server.js',
  'package.json',
  'package-lock.json',
  'start.bat',
  'icon.ico',
  'README.md',
  '.gitignore',
];
const INCLUDE_DIRS = [
  'src',
  'public',
  'node_modules',
];
/** 重建用的数据：精简词典 1.7MB + 真题源库 4MB（删了也能跑，只是没法重建） */
const INCLUDE_RAW = [
  ['tools', '_raw', 'ecdict-slim.csv'],
  ['tools', '_raw', 'exam', 'source_v2.db'],
];
/** 这些只在重新推导分段/核对答案时用，不打包 */
const EXCLUDE_RAW = ['tools/_raw/exam/pdf', 'tools/_raw/exam/answerkey'];

let bytes = 0;
let files = 0;

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else {
      fs.copyFileSync(s, d);
      bytes += fs.statSync(d).size;
      files++;
    }
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  bytes += fs.statSync(dest).size;
  files++;
}

/**
 * 打包前先把 WAL 合进主库。
 *
 * 这一步不能省：SQLite 的 WAL 模式下，最近写入的数据还留在
 * data/wordmaster.db-wal 里，只拷贝 .db 会得到一个**内容不全**的数据库
 * （实测：拷过去之后只读打开，words 和 exam_sets 都查不到，启动脚本会误判成
 * "没有数据"然后又去下载）。合并之后 .db 就是自包含的。
 */
function checkpointDb() {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(ROOT, 'data', 'wordmaster.db');
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log('  ✓ 已把 WAL 合入主库（.db 现在是自包含的）');
  } catch (err) {
    console.log(`  ! WAL 合并失败：${err.message}`);
  } finally {
    if (db) db.close();
  }
}

/** 自检：拷过去的数据库必须真的能用，否则这个包是坏的 */
function verify(dest) {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(dest, 'data', 'wordmaster.db');
  if (!fs.existsSync(dbPath)) return { ok: false, why: '缺少 data/wordmaster.db' };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const words = db.prepare('SELECT COUNT(*) AS c FROM words').get().c;
    const sets = db.prepare('SELECT COUNT(*) AS c FROM exam_sets').get().c;
    const paras = db.prepare('SELECT COUNT(DISTINCT set_id) AS c FROM exam_reading_paragraphs').get().c;
    const exps = db.prepare("SELECT COUNT(*) AS c FROM exam_questions WHERE explanation <> ''").get().c;
    return { ok: words > 0 && sets > 0, words, sets, paras, exps };
  } catch (err) {
    return { ok: false, why: err.message };
  } finally {
    if (db) db.close();
  }
}

function main() {
  console.log('  打包部署文件…\n');
  checkpointDb();
  console.log('');

  for (const f of INCLUDE_FILES) {
    const s = path.join(ROOT, f);
    if (!fs.existsSync(s)) { console.log(`  - 跳过（不存在） ${f}`); continue; }
    copyFile(s, path.join(DEST, f));
    console.log(`  ✓ ${f}`);
  }

  for (const d of INCLUDE_DIRS) {
    const s = path.join(ROOT, d);
    if (!fs.existsSync(s)) continue;
    copyDir(s, path.join(DEST, d));
    console.log(`  ✓ ${d}/`);
  }

  // 工具脚本：只带构建相关的 .js，不带那些依赖 Python 的
  const toolsDest = path.join(DEST, 'tools');
  fs.mkdirSync(toolsDest, { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'tools'))) {
    if (!f.endsWith('.js')) continue;
    copyFile(path.join(ROOT, 'tools', f), path.join(toolsDest, f));
    console.log(`  ✓ tools/${f}`);
  }

  for (const parts of INCLUDE_RAW) {
    const rel = path.join(...parts);
    const s = path.join(ROOT, rel);
    if (!fs.existsSync(s)) { console.log(`  - 跳过（不存在） ${rel}`); continue; }
    copyFile(s, path.join(DEST, rel));
    console.log(`  ✓ ${rel}`);
  }

  // 数据库：先做过 checkpoint，所以只要 .db 一个文件
  const dbDest = path.join(DEST, 'data');
  fs.mkdirSync(dbDest, { recursive: true });
  const dbFile = 'wordmaster.db';
  copyFile(path.join(ROOT, 'data', dbFile), path.join(dbDest, dbFile));
  console.log(`  ✓ data/${dbFile}`);

  console.log('');
  console.log(`  共 ${files} 个文件，${(bytes / 1048576).toFixed(1)} MB`);
  console.log(`  输出目录：${DEST}`);

  /* ---------- 自检：包必须是可用的，不能拷完才发现是空的 ---------- */
  const v = verify(DEST);
  console.log('');
  if (v.ok) {
    console.log(`  ✓ 自检通过：单词 ${v.words}、真题组 ${v.sets}、分段 ${v.paras}、解析 ${v.exps}`);
    console.log('');
    console.log('  这个包拿到别的机器上，双击 start.bat 即可 —— 不需要下载任何东西。');
  } else {
    console.log(`  ✗ 自检失败：${v.why || '数据库里查不到数据'}`);
    console.log('    这个包不能用，别拷。先解决上面的问题再重新打包。');
    process.exitCode = 1;
  }
  console.log(`  （已排除重建分段用的 ${EXCLUDE_RAW.join('、')}，需要时可以从原目录补拷。）`);
  console.log('');
}

main();
