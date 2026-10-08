'use strict';
/*
 * 一次跑完全部回归测试。
 *
 * 用法：node tools/run-tests.js [port]
 *
 * 它会在**数据库副本**上起一个隔离实例（绝不碰 data/wordmaster.db），
 * 依次跑完所有检查脚本，最后汇总。每条测试都用独立副本，互不干扰。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'wordmaster.db');
const PORT = Number(process.argv[2]) || 3980;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-tests-'));

/** 不需要服务的纯本地检查 */
const OFFLINE_TESTS = [
  { name: '排期算法（三档跳档 / fuzz / 不许倒退）', args: ['tools/check-srs.js'] },
  { name: '颜色令牌守卫（禁止绕过设计系统的硬编码）', args: ['tools/check-colors.js'] },
  { name: '前端静态检查（未定义引用 / 语法）', args: ['tools/check-frontend.js'] },
  { name: '迁移幂等性（恢复出厂设置后不二次迁移）', args: ['tools/check-migration.js'] },
  /* 重建流水线的最后一步必须跑到位 —— 重跑 clean-exam-text.py 会覆盖它的修复。
     这个 check 就是用来抓「流水线跑了一半」的。 */
  { name: '真题文本修复已应用（流水线最后一步没漏）', args: ['tools/repair-exam-text.js', '--check'] },
];

/** 需要服务的检查 */
const ONLINE_TESTS = [
  { name: '口径一致性（未学/已学/到期 三套判定）', args: ['tools/check-consistency.js', BASE, 'kaoyan'] },
  { name: '三阶段协议（first/repeat/pass）', args: ['tools/check-study-phases.js', BASE, 'cet4'] },
  { name: '判分安全性（伪造 correct / 跨组借用 / 限流）', args: ['tools/verify-quiz-grading.js', BASE, 'cet4'] },
  { name: '笔记 / 暂缓 / 顽固词', args: ['tools/check-notes-suspend.js', BASE, 'cet4'] },
  { name: '新词存活（写标记后不消失）', args: ['tools/check-new-word-survival.js', BASE, 'cet4'] },
];

function copyDb(name) {
  const dest = path.join(TMP, name);
  for (const suffix of ['', '-wal', '-shm']) {
    const from = SRC_DB + suffix;
    if (fs.existsSync(from)) fs.copyFileSync(from, dest + suffix);
  }
  return dest;
}

function run(label, args) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  // 只留最后一行汇总 + 失败行，避免刷屏
  const failLines = out.split('\n').filter((l) => l.includes('[FAIL]'));
  const summary = out.split('\n').filter((l) => /通过 \d+ 项，失败 \d+ 项/.test(l)).pop() || '';
  const okAll = out.includes('全部通过');
  return { code: r.status, out, failLines, summary, okAll };
}

console.log('\n' + '='.repeat(60));
console.log('  WordMaster 全量回归');
console.log('='.repeat(60));
console.log(`  数据库副本目录: ${TMP}`);
console.log(`  隔离实例端口  : ${PORT}\n`);

const results = [];

/* ---------- 1. 不需要服务的 ---------- */
console.log('【离线检查】');
for (const t of OFFLINE_TESTS) {
  const r = run(t.name, t.args);
  const good = r.code === 0 || r.okAll;
  results.push({ name: t.name, good, summary: r.okAll ? '全部通过' : r.summary, failLines: r.failLines });
  console.log(`  ${good ? '✓' : '✗'} ${t.name}  ${r.okAll ? '全部通过' : r.summary}`);
  r.failLines.forEach((l) => console.log(`      ${l.trim()}`));
}

/* ---------- 2. 起隔离实例，跑需要服务的 ---------- */
console.log('\n【需要服务】');
const db = copyDb('run.db');
const { spawn } = require('node:child_process');
const server = spawn(process.execPath, ['server.js', '--no-open'], {
  cwd: ROOT,
  env: { ...process.env, WM_DB: db, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d.toString(); });

/** 等服务起来 */
async function waitUp(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** 等子进程真正退出（Windows 上 kill 不是同步的） */
function waitExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const t = setTimeout(resolve, timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

(async () => {
  const up = await waitUp();
  if (!up) {
    console.error(`  ✗ 服务在 ${PORT} 起不来`);
    console.error(serverErr.split('\n').slice(0, 8).join('\n'));
    server.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`  · 隔离实例已就绪 ${BASE}\n`);

  for (const t of ONLINE_TESTS) {
    const r = run(t.name, t.args);
    const good = r.code === 0;
    results.push({ name: t.name, good, summary: r.summary, failLines: r.failLines });
    console.log(`  ${good ? '✓' : '✗'} ${t.name}  ${r.summary}`);
    r.failLines.forEach((l) => console.log(`      ${l.trim()}`));
  }

  // 服务端有没有报 API 错误（SQL 别名写错这类会被这里抓到）
  const apiErrors = (serverErr.match(/\[API 错误\][^\n]*/g) || []);
  const goodApi = apiErrors.length === 0;
  results.push({ name: '服务端无 API 错误', good: goodApi, summary: goodApi ? '无' : `${apiErrors.length} 条` });
  console.log(`\n  ${goodApi ? '✓' : '✗'} 服务端无 API 错误  ${goodApi ? '无' : apiErrors.length + ' 条'}`);
  apiErrors.slice(0, 5).forEach((l) => console.log(`      ${l}`));

  server.kill();
  /* Windows 上子进程退出后文件句柄不会立刻释放，直接删临时目录会 EPERM。
     重试几次再放弃 —— 删不掉也不该让整个测试以非 0 退出（结果才重要）。 */
  await waitExit(server);
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }

  const bad = results.filter((r) => !r.good);
  console.log('\n' + '='.repeat(60));
  console.log(`  合计 ${results.length} 项，${bad.length ? `失败 ${bad.length} 项` : '全部通过'}`);
  bad.forEach((b) => console.log(`    ✗ ${b.name}`));
  console.log('='.repeat(60) + '\n');
  process.exit(bad.length ? 1 : 0);
})();
