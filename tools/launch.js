'use strict';

/**
 * 启动器的真正逻辑（start.bat 只负责找到 node 再调这里）。
 *
 * 为什么把逻辑挪到 Node 里：
 *   .bat 里写中文会被 cmd 拆行 —— cmd 是按当前代码页逐字节解析批处理文件的，
 *   UTF-8 的中文在 `chcp 65001` 之后仍可能被拆断，症状是
 *   「'口，服务就停了。' is not recognized as an internal or external command」。
 *   所以 start.bat 保持**纯 ASCII**，中文提示全部由这里打印（Node 输出 UTF-8 没问题）。
 *
 * 它做四件事：检查环境 → 检查数据 → 看服务是否已在跑 → 启动。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORTS = [3000, 3001, 3002];

const log = (s = '') => process.stdout.write(`${s}\n`);

/** 探测某个端口上有没有在跑的服务 */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? port : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 找到已经在跑的服务端口（前三个端口都试，服务会自动往后换端口） */
async function findRunning() {
  for (const p of PORTS) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await probe(p);
    if (hit) return hit;
  }
  return null;
}

/** 打开浏览器（explorer 优先，失败退回 cmd start） */
function openBrowser(url) {
  const fallback = () => {
    try { spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 静默 */ }
  };
  try {
    const c = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
    c.on('error', fallback);
    c.unref();
  } catch { fallback(); }
}

function nodeVersionOk() {
  const v = process.versions.node.split('.').map(Number);
  return v[0] > 22 || (v[0] === 22 && v[1] >= 5);
}

/** 词库和题库是否已经就绪 */
function dataReady() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(ROOT, 'data', 'wordmaster.db'), { readOnly: true });
    const w = db.prepare('SELECT COUNT(*) c FROM words').get().c;
    const e = db.prepare('SELECT COUNT(*) c FROM exam_sets').get().c;
    db.close();
    return w > 0 && e > 0;
  } catch { return false; }
}

function runNode(script, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return r.status === 0;
}

async function main() {
  log('');
  log('  WordMaster  本地背单词应用');
  log('  ------------------------------------------');
  log('');

  /* ---------- 1. 环境 ---------- */
  if (!fs.existsSync(path.join(ROOT, 'server.js'))) {
    log('  [错误] 这个文件夹里没有 server.js');
    log('  说明 start.bat 没和项目放在一起 —— 它只能看到自己旁边的文件。');
    log('');
    log(`  当前目录：${ROOT}`);
    log('  请把整个 WordMaster 文件夹复制过来，双击文件夹里的 start.bat。');
    log('');
    return 1;
  }

  if (!nodeVersionOk()) {
    log(`  [错误] Node.js 版本太低：v${process.versions.node}`);
    log('  本项目需要 22.5 或更高版本（用到内置的 node:sqlite）。');
    log('  到 https://nodejs.org 下载安装，装完重新双击 start.bat。');
    log('');
    return 1;
  }

  /* ---------- 2. 服务是否已经在跑 ---------- */
  const running = await findRunning();
  if (running) {
    log(`  服务本来就在运行（端口 ${running}），直接打开浏览器。`);
    if (running !== 3000) {
      log(`  [注意] 不在默认的 3000 端口，所以旧地址 http://127.0.0.1:3000 是打不开的。`);
    }
    log('');
    openBrowser(`http://127.0.0.1:${running}`);
    return 0;
  }

  /* ---------- 3. 依赖 ---------- */
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) {
    log('  首次运行，正在安装依赖（需要联网，可能要几分钟）...');
    log('');
    const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: ROOT, stdio: 'inherit', shell: true,
    });
    if (npm.status !== 0 || !fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) {
      log('');
      log('  [错误] 依赖安装失败。');
      log('  常见原因：npm 不可用或不完整（比如只装了 node.exe 没装 npm）。');
      log('  验证：在本文件夹按住 Shift 右键 → 在此处打开终端，执行  npm -v');
      log('  也可以直接使用打包好的版本 —— 里面已经带了 node_modules，不需要联网。');
      log('');
      return 1;
    }
    log('');
  }

  /* ---------- 4. 数据 ---------- */
  if (!dataReady()) {
    log('  正在准备词库和题库，第一次会比较慢...');
    log('');
    if (!runNode(path.join(ROOT, 'tools', 'fetch-assets.js'))) {
      log('  [警告] 数据下载失败（检查网络），应用仍会启动，但内容会是空的。');
    }
    log('  正在构建词库...');
    if (!runNode(path.join(ROOT, 'tools', 'build-dict.js'))) {
      log('  [警告] 词库构建失败，应用仍会启动，但单词功能是空的。');
    }
    log('  正在构建题库...');
    if (!runNode(path.join(ROOT, 'tools', 'build-exam.js'))) {
      log('  [警告] 题库构建失败，应用仍会启动，但真题功能是空的。');
    }
    log('');
  }

  /* ---------- 5. 启动 ---------- */
  log('  正在启动服务，浏览器会自动打开。');
  log('  用完直接关掉这个窗口，服务就停了。');
  log('');

  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')],
    { cwd: ROOT, stdio: 'inherit' }
  );
  child.on('exit', (code) => {
    log('');
    log('  服务已停止。');
    process.exit(code || 0);
  });
  return null;   // 交给子进程，保持窗口开着
}

main().then((code) => {
  if (code !== null && code !== undefined) process.exit(code);
});
