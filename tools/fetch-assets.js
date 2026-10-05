'use strict';

/**
 * 首次运行的数据准备。
 *
 * 原来这套逻辑写在 start.bat 里，用 curl 直连 GitHub —— 国内网络下很慢，
 * 而且换镜像要写一堆批处理分支，没法测。挪到 Node 之后：
 *   · 每个资源配一组镜像，直连失败自动换下一个
 *   · 有实时进度和速度，不会看着像卡死
 *   · 关键：**已经有精简词典或已经建好库时，一个字节都不用下**
 *
 * 用法：
 *   node tools/fetch-assets.js            # 需要什么就下什么
 *   node tools/fetch-assets.js --check    # 只报告缺什么，不下载
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(__dirname, '_raw');
const CHECK_ONLY = process.argv.includes('--check');
const PREFER_MIRROR = process.argv.includes('--mirror');

const MB = 1024 * 1024;

/* GitHub 直连 + 几个国内常用的加速镜像（都已实测可用） */
const GH = 'https://raw.githubusercontent.com';
const SOURCES = [
  { name: '直连', make: (u) => u },
  { name: '镜像 ghfast', make: (u) => `https://ghfast.top/${u}` },
  { name: '镜像 gh-proxy', make: (u) => `https://gh-proxy.com/${u}` },
  { name: '镜像 ghproxy', make: (u) => `https://ghproxy.net/${u}` },
];

/** --mirror 时把直连排到最后，先走镜像（国内网络直连经常很慢） */
function sourceOrder() {
  return PREFER_MIRROR ? [...SOURCES.slice(1), SOURCES[0]] : SOURCES;
}

const ECDICT_URL = `${GH}/skywind3000/ECDICT/master/ecdict.csv`;
const EXAM_URL = `${GH}/ShepiTT/CET_practice_questions/main/instance/cet4_v2.db`;

/* 精简词典优先：1.7MB，和全量 62.9MB 构建出来的结果完全一致 */
const SLIM_FILE = path.join(RAW, 'ecdict-slim.csv');
const FULL_FILE = path.join(RAW, 'ecdict.csv');
const EXAM_FILE = path.join(RAW, 'exam', 'source_v2.db');

function fmtBytes(n) {
  return n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/** 带镜像轮换 + 进度 的下载。sources = [{name, url}]。返回 true 表示成功 */
async function download(sources, dest, label) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  for (let i = 0; i < sources.length; i++) {
    const { name: tag, url } = sources[i];
    process.stdout.write(`  ${label} · ${tag} … `);
    const t0 = Date.now();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3 * 60 * 1000);
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const total = Number(res.headers.get('content-length') || 0);
      const chunks = [];
      let got = 0;
      let lastLog = 0;

      for await (const chunk of res.body) {
        chunks.push(chunk);
        got += chunk.length;
        const now = Date.now();
        if (now - lastLog > 400) {
          lastLog = now;
          const sec = (now - t0) / 1000;
          const speed = got / sec / MB;
          const pct = total ? ` ${((got / total) * 100).toFixed(0)}%` : '';
          process.stdout.write(`\r  ${label} · ${tag} … ${fmtBytes(got)}${pct}  ${speed.toFixed(1)} MB/s   `);
        }
      }
      clearTimeout(timer);

      const buf = Buffer.concat(chunks);
      if (buf.length < 10000) throw new Error('内容过小，疑似被拦截');
      fs.writeFileSync(dest, buf);

      const sec = (Date.now() - t0) / 1000;
      console.log(`\r  ✓ ${label}  ${fmtBytes(buf.length)}  用时 ${sec.toFixed(1)}s  平均 ${(buf.length / sec / MB).toFixed(1)} MB/s`);
      return true;
    } catch (e) {
      console.log(`\r  ✗ ${label} · ${tag} 失败：${e.message}          `);
    }
  }
  console.log(`  ✗ ${label} 所有来源都失败。稍后重跑本脚本即可继续。`);
  return false;
}

async function main() {
  console.log('');
  console.log('  检查数据完整性…');
  console.log('');

  const haveSlim = fs.existsSync(SLIM_FILE);
  const haveFull = fs.existsSync(FULL_FILE);
  const haveExam = fs.existsSync(EXAM_FILE);

  console.log(`  精简词典 ${path.basename(SLIM_FILE).padEnd(18)} ${haveSlim ? '✓ 已就绪' : '— 缺失'}`);
  console.log(`  全量词典 ecdict.csv           ${haveFull ? '✓ 已就绪' : '— 缺失（不是必需）'}`);
  console.log(`  真题源库 source_v2.db         ${haveExam ? '✓ 已就绪' : '— 缺失'}`);
  console.log('');

  if (CHECK_ONLY) {
    if (haveSlim || haveExam) console.log('  （--check 模式，不下载）');
    return;
  }

  // 有精简词典就不用碰全量词典了
  if (!haveSlim && !haveFull) {
    console.log('  词典数据缺失，开始下载（62.9 MB，之后会自动精简到 1.7 MB）');
    console.log('  直连慢的话会自动切到国内镜像，不用管。');
    console.log('');
    const ok = await download(sourceOrder().map((s) => ({ name: s.name, url: s.make(ECDICT_URL) })), FULL_FILE, '下载全量词典');
    if (ok) {
      console.log('');
      console.log('  正在精简词典…');
      try {
        require('node:child_process').execFileSync(
          process.execPath, [path.join(__dirname, 'make-slim-dict.js')], { stdio: 'inherit' }
        );
      } catch (e) {
        console.log('  精简失败，不影响使用（会直接用全量词典）');
      }
    }
    console.log('');
  }

  if (!haveExam) {
    console.log('  真题源库缺失，开始下载（4.0 MB）');
    console.log('');
    await download(sourceOrder().map((s) => ({ name: s.name, url: s.make(EXAM_URL) })), EXAM_FILE, '下载真题源库');
    console.log('');
  }

  const finalSlim = fs.existsSync(SLIM_FILE);
  const finalFull = fs.existsSync(FULL_FILE);
  const finalExam = fs.existsSync(EXAM_FILE);

  if ((finalSlim || finalFull) && finalExam) {
    console.log('  数据齐了，继续构建。');
    if (finalFull && finalSlim) {
      console.log(`  提示：全量词典（${fmtBytes(fs.statSync(FULL_FILE).size)}）已经用不到了，`);
      console.log('        精简词典 1.7 MB 就够，可以删掉它腾空间。');
    }
  } else {
    console.log('  数据还不完整，构建可能失败。可以再跑一次本脚本重试。');
  }
  console.log('');
}

main().catch((e) => {
  console.error('  出错：', e.message);
  process.exit(1);
});
