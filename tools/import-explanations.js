'use strict';

/**
 * 把源题库里的真题解析导进来。
 *
 * 源题库的 question.explanation 存着真题原版解析，格式很好用：
 *   阅读：  <正确答案的中文意思>。 详解：定位第一段，作者说“…” ，即…。
 *          B项（…）错误，原文是…；C项（…）未提及；D项（…）…。涉及知识点：细节理解
 *   匹配：  题干“…”对应 D 段：“…”。题干中“…”对应原文“…”。涉及知识点：语义概括
 *
 * 为什么要单独一个脚本而不是重建题库：重建会清掉
 * 「阅读分段」和「补回的缺失题目」两个后处理结果，重跑一遍要两分多钟。
 * 这里只做追加，不动其他数据。
 *
 * 用法：node tools/import-explanations.js
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'tools', '_raw', 'exam', 'source_v2.db');

const db = require(path.join(ROOT, 'src', 'db.js'));
const src = new DatabaseSync(SRC, { readOnly: true });

/* 源数据 → (卷号, 题型, 题号) → 解析 */
const KEY_OF = { reading: 'reading', matching: 'matching' };
const rows = src.prepare(`
  SELECT g.source_file, g.group_type, q.q_number, q.explanation
    FROM question q JOIN question_group g ON g.id = q.group_id
   WHERE g.group_type IN ('reading','matching')
     AND q.explanation IS NOT NULL AND q.explanation <> ''
`).all();

/** 源文件名 2024-06-CET4-1.pdf → 2024-06-CET4-1 */
const codeOf = (f) => String(f).replace(/\.pdf$/i, '');

/* ------------------------------------------------------------------ */
/* 清洗                                                                */
/* ------------------------------------------------------------------ */

/*
 * 源解析是 OCR 出来的，有两个毛病：
 *   1. 硬换行断在句子中间（"研究人\n员"、"影\n响"）
 *   2. 页脚水印混进正文（"四级2019年6月20" 插在句子中间）
 * 不清掉的话解析根本没法读。
 */
const NOISE_SUBS = [
  /[四六]级\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}/g,      // 四级2019年6月20
  /\d{4}\s*年\s*\d{1,2}\s*月\s*[四六]级/g,                // 2019年6月四级
  /\d{1,3}\s*[四六][级线]\s*\d{4}\s*[.．]\s*\d{1,2}/g,    // 46四线2025.6
  /英语[四六]级真题?/g,
  /pastpapers\s*\.?\s*cn/gi,
  /https?:\/\/\S+/gi,
];

/*
 * 部分解析的开头把「题目中文译文 + 四个选项」也 OCR 进来了，
 * 变成一大段没法读的乱码，真正的解析在后面。这里把它裁掉。
 *
 * 标记有优先级：从 【定位】/【解析】/【精析】 这类「解析正文」的开头裁，
 * 比从 【答案】 裁好 —— 【答案】 后面往往还跟着一串选项碎片。
 */
const LEAD_MARKERS = [
  '【定位】', '【解析】', '【精析】', '【避错】', '【答案】',
  '详解：', '解析：', '定位：',
];

function trimLead(text) {
  for (const m of LEAD_MARKERS) {
    const i = text.indexOf(m);
    if (i > 8) return text.slice(i);
  }
  // 没有标记的：开头若是一段带选项的问句，就从「定位到…」附近开始
  const m = text.match(/.{0,60}?(?:可以)?定位[到至]/);
  if (m && m.index > 30) return text.slice(m.index);
  return text;
}

function cleanExplanation(raw) {
  const lines = String(raw)
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => {
      let t = s;
      for (const re of NOISE_SUBS) t = t.replace(re, '');
      return t.trim();
    })
    .filter((s) => s.length > 0);

  // 逐行拼接：中文换行是硬折行，不加空格；
  // 换行两侧都是英文字母则是英文单词被断，补空格
  let out = '';
  for (const line of lines) {
    if (!out) { out = line; continue; }
    const bothLatin = /[A-Za-z]/.test(out[out.length - 1]) && /[A-Za-z]/.test(line[0]);
    out += (bothLatin ? ' ' : '') + line;
  }
  out = trimLead(out.replace(/\s{2,}/g, ' ').trim());
  return out.replace(/\s{2,}/g, ' ').trim();
}

const explainMap = new Map();
for (const r of rows) {
  const kind = KEY_OF[r.group_type];
  if (!kind) continue;
  const cleaned = cleanExplanation(r.explanation);
  if (cleaned.length < 10) continue;
  explainMap.set(`${codeOf(r.source_file)}|${kind}|${r.q_number}`, cleaned);
}
console.log(`源题库解析共 ${rows.length} 条，清洗后可用 ${explainMap.size} 条`);

/* 我的库：逐题匹配 */
const mine = db.query(`
  SELECT q.id, q.q_number, s.kind, p.code, COALESCE(q.explanation,'') AS explanation
    FROM exam_questions q
    JOIN exam_sets s ON s.id = q.set_id
    JOIN exam_papers p ON p.id = s.paper_id
`);

let filled = 0;
let skippedNoSource = 0;
let already = 0;

db.transaction(() => {
  for (const q of mine) {
    const text = explainMap.get(`${q.code}|${q.kind}|${q.q_number}`);
    if (!text) { skippedNoSource++; continue; }
    if (q.explanation === text) { already++; continue; }
    db.execute('UPDATE exam_questions SET explanation = ? WHERE id = ?', [text, q.id]);
    filled++;
  }
});

const after = db.queryOne(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN explanation IS NOT NULL AND explanation <> '' THEN 1 ELSE 0 END) AS has
    FROM exam_questions
`);
const byKind = db.query(`
  SELECT s.kind, COUNT(*) AS total,
         SUM(CASE WHEN q.explanation IS NOT NULL AND q.explanation <> '' THEN 1 ELSE 0 END) AS has
    FROM exam_questions q JOIN exam_sets s ON s.id = q.set_id
   GROUP BY s.kind
`);

console.log('');
console.log(`本次写入 ${filled} 条（本来就有 ${already} 条，源里没有 ${skippedNoSource} 条）`);
console.log('');
console.log('覆盖率：');
for (const k of byKind) {
  console.log(`  ${k.kind.padEnd(10)} ${k.has}/${k.total}  ${Math.round((k.has / k.total) * 100)}%`);
}
console.log(`  合计       ${after.has}/${after.total}  ${Math.round((after.has / after.total) * 100)}%`);
console.log('');
console.log('样例：');
const s = db.queryOne(`SELECT q.q_number, q.explanation FROM exam_questions q
  WHERE q.explanation IS NOT NULL AND q.explanation <> '' LIMIT 1`);
console.log(`  Q${s.q_number}: ${s.explanation.slice(0, 160)}...`);
