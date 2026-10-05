'use strict';

/**
 * 从全量 ECDICT（62.9MB）里抽出本应用真正用到的那部分，生成精简词典。
 *
 * 为什么值得：build-dict.js 只按 tag 抽 cet4 / cet6 / ky 三个词表的词（6158 个），
 * 却要下载 77 万行的全量 CSV。精简后体积能小两个数量级，
 * 而且部署时把文件夹复制过去就行，不用再走网络。
 *
 * 输出与全量 CSV **同格式**（表头一致、列不动），只是行少了，
 * 所以 build-dict.js 不用改解析逻辑，只要优先读精简文件即可。
 *
 * 用法：node tools/make-slim-dict.js
 */

const fs = require('node:fs');
const path = require('node:path');

const RAW = path.join(__dirname, '_raw');
const SRC = path.join(RAW, 'ecdict.csv');
const OUT = path.join(RAW, 'ecdict-slim.csv');
const BOOK_TAGS = ['cet4', 'cet6', 'ky'];

if (!fs.existsSync(SRC)) {
  console.error(`找不到全量词典：${SRC}`);
  console.error('下载：');
  console.error('  curl -L -o tools/_raw/ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv');
  process.exit(1);
}

/* ECDICT 的 translation 列含逗号/引号，必须正经解析 CSV，不能 split(',') */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const raw = fs.readFileSync(SRC, 'utf8');
const lines = raw.split('\n');
const header = parseCsvLine(lines[0]);
const iTag = header.indexOf('tag');
if (iTag < 0) {
  console.error('表头里没有 tag 列，无法筛选');
  process.exit(1);
}

const kept = [];
const tagCount = {};
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  // 先用便宜的预筛，避免每行都跑完整 CSV 解析
  if (!/cet4|cet6|ky/.test(line)) continue;
  const cols = parseCsvLine(line);
  const tags = String(cols[iTag] || '').trim();
  if (!tags) continue;
  const hit = tags.split(/\s+/).filter((t) => BOOK_TAGS.includes(t));
  if (!hit.length) continue;
  kept.push(line);
  for (const t of hit) tagCount[t] = (tagCount[t] || 0) + 1;
}

fs.writeFileSync(OUT, header.join(',') + '\n' + kept.join('\n') + '\n', 'utf8');

const srcMb = fs.statSync(SRC).size / 1048576;
const outMb = fs.statSync(OUT).size / 1048576;
console.log(`  全量词典 ${srcMb.toFixed(1)} MB → 精简词典 ${outMb.toFixed(2)} MB`);
console.log(`  保留 ${kept.length} 行（缩小 ${(srcMb / outMb).toFixed(0)} 倍）`);
console.log('  各词表命中：', Object.entries(tagCount).map(([k, v]) => `${k}:${v}`).join('  '));
console.log(`  输出：${OUT}`);
