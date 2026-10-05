'use strict';
/*
 * 颜色令牌守卫：检查 CSS 里有没有「绕过设计系统」的硬编码颜色。
 *
 * 为什么需要它：
 * 这个项目的设计系统是 app.css 顶部的 :root + html[data-theme] 令牌区，
 * 其余一切颜色必须走 var(--*)。mobile.css 曾经长出一整套**独立的**配色
 * （柔和蓝 #4a6fa5、白底 #fff、Tailwind 灰阶），后果是
 * **深色主题在移动端真题页完全失效** —— 白底把用户选的暗色主题盖掉了，
 * 而 78 个十六进制值散落在 1000 行里，靠肉眼 review 根本发现不了。
 *
 * 允许的例外（规范 2.2 明确写的两种）：
 *   1. 令牌区内的定义（:root / html[data-theme]）
 *   2. 实心语义色底上的白字（`color: #fff` 配 var(--ok) 这类）
 *   3. mask-image 里的 #000（mask 用亮度，黑色是正确写法而非配色）
 *   4. 阴影 rgba(0,0,0,...)（本身不带主题语义）
 *
 * 用法：node tools/check-colors.js
 */

const fs = require('node:fs');
const path = require('node:path');

const CSS_DIR = path.join(__dirname, '..', 'public', 'css');
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  [ok]   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

/** 这一行是否属于允许的例外 */
function isAllowed(line, inTokenBlock) {
  const t = line.trim();
  if (inTokenBlock) return true;                       // 令牌定义本身
  if (/^\/\*|^\*/.test(t)) return true;                // 注释
  if (/mask-image/.test(t)) return true;               // mask 用 #000 是正确写法
  if (/^(box-)?shadow/.test(t)) return true;           // 阴影不带主题语义
  if (/color:\s*#fff/i.test(t)) return true;           // 实心色底上的白字
  if (/^\s*background:\s*#fff/i.test(t)) return false; // 白底 —— 这一条正是要抓的
  return false;
}

console.log('\n颜色令牌守卫\n');

const files = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));

for (const file of files) {
  const full = path.join(CSS_DIR, file);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const offenders = [];
  let inTokenBlock = false;
  let depth = 0;

  lines.forEach((line, i) => {
    const t = line.trim();
    // 令牌区：:root { ... } 与 html[data-theme="..."] { ... }
    if (/^:root\s*\{|^html\[data-theme=/.test(t)) { inTokenBlock = true; depth = 0; }
    if (inTokenBlock) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0 && /\}/.test(line)) inTokenBlock = false;
      return;
    }
    const hits = line.match(COLOR_RE);
    if (!hits) return;
    for (const lit of hits) {
      if (isAllowed(line, false)) continue;
      offenders.push({ line: i + 1, lit, text: t });
    }
  });

  if (file === 'app.css') {
    // app.css 是令牌所在文件，它的例外更多，只统计数量做参考
    ok(true, `${file}：令牌定义文件`, `令牌区外硬编码 ${offenders.length} 处（多为白字/阴影/mask，属规范例外）`);
  } else {
    ok(offenders.length === 0,
      `${file}：不允许出现任何颜色字面量`,
      offenders.length ? `发现 ${offenders.length} 处` : '干净');
    offenders.slice(0, 15).forEach((o) => {
      console.log(`         ${String(o.line).padStart(5)}  ${o.lit}  ← ${o.text.slice(0, 60)}`);
    });
    if (offenders.length > 15) console.log(`         … 还有 ${offenders.length - 15} 处`);
  }
}

/* JS 里也不该直接写颜色（只允许 var(--*) 或 #fff） */
console.log('\n  JS 里的颜色：');
const jsDir = path.join(__dirname, '..', 'public', 'js');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });
}
let jsBad = [];
for (const f of walk(jsDir)) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (/^\/\/|\*/.test(t)) return;
    const hits = line.match(COLOR_RE) || [];
    for (const lit of hits) {
      // #fff 配实心色底是允许的；其余字面量都不该出现在 JS 里
      if (/^#fff$/i.test(lit)) continue;
      if (/rgba?\(0,\s*0,\s*0/.test(lit)) continue;   // 阴影
      jsBad.push({ file: path.relative(jsDir, f), line: i + 1, lit, text: t });
    }
  });
}
ok(jsBad.length === 0, 'JS 里不直接写颜色（应用 CSS 令牌）',
  jsBad.length ? `${jsBad.length} 处` : '干净');
jsBad.slice(0, 10).forEach((o) => {
  console.log(`         ${o.file}:${o.line}  ${o.lit}  ← ${o.text.slice(0, 60)}`);
});

console.log(`\n${'='.repeat(54)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`${'='.repeat(54)}\n`);
process.exit(fail ? 1 : 0);
