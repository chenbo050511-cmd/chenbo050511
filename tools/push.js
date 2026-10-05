'use strict';
/*
 * 一键推送到 GitHub。
 *
 * 用法：
 *   node tools/push.js                    推送到默认远程 origin
 *   node tools/push.js <远程地址>          首次推送时指定地址
 *   node tools/push.js <远程地址> --set    同时把地址写进 origin
 *
 * 为什么需要这个脚本：
 *  git 在 Windows 上**不读系统代理设置**（注册表里的 ProxyServer 它看不见），
 *  所以如果你在用 Clash / v2ray 之类的本地代理，直接 `git push` 往往一直挂着不动。
 *  这里会自动探测常见代理端口并配好 http(s).proxy，然后推送。
 */

const { spawnSync } = require('node:child_process');
const net = require('node:net');

const PROXY_CANDIDATES = [7890, 7897, 10809, 10808, 1080, 8889, 2080];
const DEFAULT_REMOTE = process.env.WM_REMOTE || 'https://github.com/chenbo050511/WordMaster.git';

function run(args, opts = {}) {
  // stdio: 'inherit' —— 推送过程要让用户看到进度（也避免管道缓冲问题）
  return spawnSync('git', args, { stdio: 'inherit', ...opts });
}

function capture(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

/** 探测本地是否有可用的代理端口 */
function findProxy() {
  return new Promise((resolve) => {
    let pending = PROXY_CANDIDATES.length;
    let found = null;
    for (const port of PROXY_CANDIDATES) {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        if (!found) found = port;
        if (--pending === 0) resolve(found);
      });
      sock.on('error', () => {
        if (--pending === 0) resolve(found);
      });
      sock.setTimeout(600, () => {
        sock.destroy();
        if (--pending === 0) resolve(found);
      });
    }
    if (!pending) resolve(null);
  });
}

(async () => {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const setRemote = process.argv.includes('--set');
  const remoteArg = args[0];
  const remote = remoteArg || DEFAULT_REMOTE;

  console.log('\n  WordMaster 推送助手\n');

  /* 1. 仓库状态自检 —— 推之前先确认没有把私人数据带出去 */
  const branch = capture(['branch', '--show-current']) || 'main';
  const count = capture(['rev-list', '--count', 'HEAD']);
  if (!count) {
    console.error('  ✗ 还没有任何提交，先 commit 再推送。');
    process.exit(1);
  }
  const tracked = capture(['ls-files']).split('\n').filter(Boolean);
  const leak = tracked.filter((f) => /^data\/|^node_modules\/|_raw\/|\.db$|\.db\./.test(f));
  console.log(`  分支 ${branch} · ${count} 个提交 · ${tracked.length} 个文件`);
  if (leak.length) {
    console.error('\n  ✗ 发现不该提交的文件，已中止：');
    leak.slice(0, 10).forEach((f) => console.error('      ' + f));
    console.error('    请先修 .gitignore 并 git rm --cached 掉它们。\n');
    process.exit(1);
  }
  console.log('  ✓ 未包含数据库 / 依赖 / 原始语料');

  /* 2. 代理 */
  const existing = capture(['config', '--get', 'https.proxy']);
  if (existing) {
    console.log(`  ✓ 已配置代理 ${existing}`);
  } else {
    const port = await findProxy();
    if (port) {
      capture(['config', 'https.proxy', `http://127.0.0.1:${port}`]);
      capture(['config', 'http.proxy', `http://127.0.0.1:${port}`]);
      console.log(`  ✓ 探测到本地代理，已配置为 127.0.0.1:${port}`);
    } else {
      console.log('  · 没探测到本地代理，将直连');
    }
  }

  /* 3. 远程 */
  const hasOrigin = capture(['remote']).split('\n').filter(Boolean).includes('origin');
  if (setRemote || !hasOrigin) {
    if (hasOrigin) run(['remote', 'set-url', 'origin', remote]);
    else run(['remote', 'add', 'origin', remote]);
  }
  console.log(`  ✓ 远程 origin = ${capture(['remote', 'get-url', 'origin'])}\n`);

  /* 4. 推送 */
  console.log('  正在推送…\n');
  const r = run(['push', '-u', 'origin', branch]);
  if (r.status !== 0) {
    console.error('\n  ✗ 推送失败。常见原因：');
    console.error('     · 仓库还没在 GitHub 上创建（先去网页新建一个空仓库，别勾 README）');
    console.error('     · 地址里的用户名不对（改成你自己的）');
    console.error('     · 认证没通过（凭据管理器里没存 GitHub 账号）');
    console.error('     · 代理没开／端口不是常见的那几个\n');
    process.exit(r.status || 1);
  }
  console.log('\n  ✓ 推送完成\n');
})();
