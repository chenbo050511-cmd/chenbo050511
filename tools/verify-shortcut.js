'use strict';

/**
 * 按 MS-SHLLINK 规范解析 .lnk，用于校验 make-shortcut.js 生成的文件是否正确。
 * 用法：node tools/verify-shortcut.js "C:\Users\20232\Desktop\WordMaster 背单词.lnk"
 */

const fs = require('node:fs');

const file = process.argv[2];
if (!file) {
  console.error('用法: node tools/verify-shortcut.js <lnk 路径>');
  process.exit(1);
}

const b = fs.readFileSync(file);
let pass = 0;
let fail = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  const shown = typeof actual === 'string' ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(22)} ${shown}${ok ? '' : `  （期望 ${JSON.stringify(expected)}）`}`);
};

console.log(`文件: ${file}`);
console.log(`大小: ${b.length} 字节\n`);

/* ---------- ShellLinkHeader ---------- */
check('HeaderSize', b.readUInt32LE(0), 76);
check('LinkCLSID', b.slice(4, 20).toString('hex'), '0104020000000000c000000000000046');
check('HasLinkInfo', !!(b.readUInt32LE(20) & 0x02), true);
check('HasWorkingDir', !!(b.readUInt32LE(20) & 0x10), true);
check('HasIconLocation', !!(b.readUInt32LE(20) & 0x40), true);
check('IsUnicode', !!(b.readUInt32LE(20) & 0x80), true);
check('ShowCommand', b.readUInt32LE(60), 1);

/* ---------- LinkInfo ---------- */
let o = 76;
const linkInfoSize = b.readUInt32LE(o);
check('LinkInfo 内部自洽', b.readUInt32LE(o + 4) + (linkInfoSize - b.readUInt32LE(o + 4)) === linkInfoSize, true);
check('LinkInfoFlags', b.readUInt32LE(o + 8), 1);

const vo = b.readUInt32LE(o + 12);
const po = b.readUInt32LE(o + 16);
const so = b.readUInt32LE(o + 24);
const ansiAt = (abs) => {
  let e = abs;
  while (b[e] !== 0) e++;
  return b.slice(abs, e).toString('latin1');
};

check('LocalBasePath', ansiAt(o + po), 'D:\\WordMaster\\start.bat');
check('CommonPathSuffix', ansiAt(o + so), '');
check('VolumeID DriveType', b.readUInt32LE(o + vo + 4), 3);
o += linkInfoSize;

/* ---------- StringData（Unicode） ---------- */
const uAt = () => {
  const n = b.readUInt16LE(o);
  const s = b.slice(o + 2, o + 2 + n * 2).toString('utf16le');
  o += 2 + n * 2;
  return s;
};
check('WorkingDir', uAt(), 'D:\\WordMaster');
check('IconLocation', uAt(), 'D:\\WordMaster\\icon.ico');

console.log(`\n解析消耗 ${o} / 文件 ${b.length} 字节 ${o === b.length ? '✓ 无残留' : '✗ 有残留'}`);
if (o === b.length) pass++; else fail++;

/* ---------- 目标与图标文件是否真实存在 ---------- */
const targets = [
  ['目标 start.bat', 'D:\\WordMaster\\start.bat'],
  ['图标 icon.ico', 'D:\\WordMaster\\icon.ico'],
];
console.log('');
for (const [label, p] of targets) {
  const ok = fs.existsSync(p);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(22)} ${ok ? '存在' : '不存在：' + p}`);
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败${fail === 0 ? '  ✅ 全部通过' : ''}`);
process.exit(fail === 0 ? 0 : 1);
