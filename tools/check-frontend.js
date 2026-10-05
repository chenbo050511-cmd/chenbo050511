'use strict';
/**
 * 前端健壮性检查 —— 防止「调用了不存在的函数」这类低级错误再次上线。
 *
 * 背景：
 *   2026-09-30 用户报「学新词和复习都加载失败」。查下来是 study.js 里
 *   调用了 4 个**根本没定义**的函数（highlightWord / autoSpeak /
 *   loadNextBatch / fetchBatch），另一个函数 showFeedback 还多传了一个
 *   不存在的变量 res。因为 load() 的 catch 把它统一吞成「加载失败，请重试」，
 *   用户完全看不到原因，只能报「加载失败」。
 *
 *   这类错误语法检查抓不到（`node --check` 会通过），只有运行时才炸。
 *   所以这里做一次静态分析：把每个文件里「被调用、但文件内没定义、
 *   又不是已知全局」的标识符列出来。
 *
 * 用法：
 *   node tools/check-frontend.js
 *   有可疑项时退出码为 1，可以直接接进 CI 或提交前钩子。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'public', 'js');

/** 浏览器 / JS 内置 & 跨文件共享的全局，出现时不算可疑 */
const KNOWN_GLOBAL = new Set([
  // 语言内置
  'console', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
  'RegExp', 'Error', 'TypeError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol',
  'Proxy', 'Reflect', 'Intl', 'BigInt', 'ArrayBuffer', 'Uint8Array', 'Infinity', 'NaN',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'fetch', 'alert', 'confirm', 'prompt', 'btoa', 'atob', 'URL', 'URLSearchParams',
  // 浏览器宿主
  'window', 'document', 'location', 'navigator', 'localStorage', 'sessionStorage',
  'speechSynthesis', 'SpeechSynthesisUtterance', 'Audio', 'Image', 'FileReader', 'Blob',
  'XMLHttpRequest', 'WebSocket', 'Worker', 'CustomEvent', 'Event', 'AbortController',
  'matchMedia', 'getComputedStyle', 'history', 'screen', 'performance', 'crypto',
  // 语言关键字（被正则误当函数调用的）
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'delete',
  'void', 'in', 'of', 'do', 'else', 'try', 'function', 'async', 'super', 'this',
  // 项目内跨文件共享（由其它 js 定义后挂到 window）
  'UI', 'API', 'App', 'Views', 'Charts',
  // 常见数组/字符串方法名（避免把 obj.map(...) 之类误报成全局调用）
  'map', 'filter', 'forEach', 'reduce', 'find', 'findIndex', 'some', 'every', 'includes',
  'indexOf', 'lastIndexOf', 'slice', 'splice', 'concat', 'sort', 'reverse', 'join', 'split',
  'replace', 'replaceAll', 'match', 'matchAll', 'search', 'test', 'exec', 'trim', 'trimStart',
  'trimEnd', 'padStart', 'padEnd', 'startsWith', 'endsWith', 'repeat', 'charAt', 'charCodeAt',
  'toUpperCase', 'toLowerCase', 'toString', 'valueOf', 'keys', 'values', 'entries', 'assign',
  'freeze', 'from', 'isArray', 'stringify', 'parse', 'abs', 'round', 'floor', 'ceil', 'min',
  'max', 'random', 'pow', 'sqrt', 'sign', 'trunc', 'push', 'pop', 'shift', 'unshift',
  'apply', 'call', 'bind', 'then', 'catch2', 'finally', 'resolve', 'reject', 'all', 'race',
  'has', 'get', 'set', 'add', 'delete2', 'clear', 'next', 'throw', 'return2',
]);

/** 收集一个文件里定义了哪些名字 */
function collectDefined(src) {
  const defined = new Set();
  // function foo(...)
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  // const/let/var foo = ...
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  // 解构 const { a, b } = ...
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
    m[1].split(',').forEach((p) => {
      const n = p.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
    });
  }
  // 解构数组 const [a, b] = ...
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]+)\]\s*=/g)) {
    m[1].split(',').forEach((p) => {
      const n = p.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
    });
  }
  // 函数参数
  for (const m of src.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    m[1].split(',').forEach((p) => {
      const n = p.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
    });
  }
  // 箭头函数参数 (a, b) => / a =>
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
    m[1].split(',').forEach((p) => {
      const n = p.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
    });
  }
  for (const m of src.matchAll(/(?:^|[\s,;(])([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1]);
  // 对象字面量里的方法简写：`init() {` / `async foo() {`
  // 这些是**定义**不是调用，必须排除，否则 mobile.js 的 Mobile.init() 会被误报。
  for (const m of src.matchAll(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    defined.add(m[1]);
  }
  // 类的方法定义
  for (const m of src.matchAll(/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    defined.add(m[1]);
  }
  // 函数内声明的 function 名（上面的正则已覆盖）
  return defined;
}

/** 收集所有「看起来像函数调用」的名字 */
function collectCalled(src) {
  const called = new Map();
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;   // 跳过纯注释行
    // 去掉字符串字面量，避免 "translate(" 这种被误判
    const noStr = line
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    // 再去掉行尾注释
    const code = noStr.replace(/\/\/.*$/, '');

    // 跳过 CSS 声明行 —— 模板字符串里写样式时会出现
    // `transform: translate(-50%, -50%);` 这种，translate/filter/rotate 等
    // 都是 CSS 函数而非 JS 调用。判据：行首是 `css属性名:` 的形式。
    if (/^\s*[a-z-]+\s*:\s/.test(t) && !/^\s*(?:return|case|default|typeof|new)\b/.test(t)) return;

    for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const n = m[1];
      if (!called.has(n)) called.set(n, []);
      called.get(n).push(i + 1);
    }
  });
  return called;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function main() {
  const files = walk(JS_DIR).sort();
  let totalIssues = 0;

  // 所有文件定义的全局（跨文件共享的挂载）
  const allDefined = new Set();
  const perFile = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const d = collectDefined(src);
    perFile.set(f, { src, defined: d });
    d.forEach((n) => allDefined.add(n));
  }

  console.log('');
  console.log('  前端健壮性检查');
  console.log('  ' + '-'.repeat(50));

  for (const f of files) {
    const { src, defined } = perFile.get(f);
    const called = collectCalled(src);
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const issues = [];

    for (const [name, lines] of called) {
      if (defined.has(name)) continue;
      if (KNOWN_GLOBAL.has(name)) continue;
      if (allDefined.has(name)) continue;          // 别的文件定义了（挂到 window）
      issues.push({ name, lines });
    }

    if (issues.length) {
      totalIssues += issues.length;
      console.log(`  [!] ${rel}`);
      issues.forEach((it) => console.log(`      调用了未定义: ${it.name}()  行 ${it.lines.join(', ')}`));
    } else {
      console.log(`  [ok] ${rel}`);
    }
  }

  console.log('  ' + '-'.repeat(50));
  if (totalIssues) {
    console.log(`  发现 ${totalIssues} 处可疑调用 —— 这些会在运行时抛 ReferenceError`);
    console.log('  注意：极少数是误报（比如 CSS 里的 translate(...)），请人工确认。');
    console.log('');
    process.exit(1);
  }
  console.log('  全部通过');
  console.log('');
  return 0;
}

main();
