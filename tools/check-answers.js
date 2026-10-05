'use strict';

/**
 * 答案完整性检查：
 *  1. 每道阅读题的答案字母，是否真的存在于它的选项里
 *  2. 每道匹配题的答案字母，是否真的存在于该组的段落里
 *  3. 同一道题的选项文字有没有重复（重复会让用户"选对了却被判错"）
 *  4. 答案分布是否异常（比如全是 A，或某个字母从不出现）
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'wordmaster.db'), { readOnly: true });
const all = (s, params = []) => db.prepare(s).all(...params);

let bad = 0;
const report = (msg) => { console.log('  ✗ ' + msg); bad++; };

/* ---------- 1 & 3：阅读题 ---------- */
console.log('=== 阅读题 ===');
const readQs = all(`
  SELECT q.id, q.set_id, q.q_number, q.answer, q.stem, s.title, p.code
    FROM exam_questions q
    JOIN exam_sets s ON s.id = q.set_id
    JOIN exam_papers p ON p.id = s.paper_id
   WHERE s.kind = 'reading'
`);
let optMismatch = 0;
let dupText = 0;
for (const q of readQs) {
  const opts = all('SELECT label, text FROM exam_options WHERE question_id = ? ORDER BY seq', [q.id]);
  const labels = opts.map((o) => o.label);
  if (!labels.includes(q.answer)) {
    optMismatch++;
    if (optMismatch <= 5) report(`${q.code} Q${q.q_number} 答案=${q.answer} 但选项只有 ${labels.join('')}`);
  }
  const texts = opts.map((o) => (o.text || '').trim().toLowerCase());
  if (new Set(texts).size !== texts.length) {
    dupText++;
    if (dupText <= 5) {
      const seen = new Set(); const dup = texts.find((t) => (seen.has(t) ? true : (seen.add(t), false)));
      report(`${q.code} Q${q.q_number} 选项文字重复: ${dup.slice(0, 50)}`);
    }
  }
}
console.log(`  阅读题 ${readQs.length} 道；答案不在选项里的 ${optMismatch} 道；选项文字重复的 ${dupText} 道`);

/* ---------- 2：匹对题 ---------- */
console.log('\n=== 段落匹配题 ===');
const matchQs = all(`
  SELECT q.id, q.set_id, q.q_number, q.answer, s.title, p.code
    FROM exam_questions q
    JOIN exam_sets s ON s.id = q.set_id
    JOIN exam_papers p ON p.id = s.paper_id
   WHERE s.kind = 'matching'
`);
let paraMismatch = 0;
for (const q of matchQs) {
  const labels = all('SELECT label FROM exam_paragraphs WHERE set_id = ? ORDER BY seq', [q.set_id]).map((r) => r.label);
  if (!labels.includes(q.answer)) {
    paraMismatch++;
    if (paraMismatch <= 5) report(`${q.code} Q${q.q_number} 答案=${q.answer} 但段落只有 ${labels.join('')}`);
  }
}
console.log(`  匹配题 ${matchQs.length} 道；答案不在段落里的 ${paraMismatch} 道`);

/* ---------- 4：答案分布 ---------- */
console.log('\n=== 答案字母分布（阅读）===');
const dist = {};
for (const q of readQs) dist[q.answer] = (dist[q.answer] || 0) + 1;
console.log('  ' + Object.entries(dist).sort().map(([k, v]) => `${k}:${v}`).join('  '));

console.log('\n=== 答案字母分布（匹配）===');
const dist2 = {};
for (const q of matchQs) dist2[q.answer] = (dist2[q.answer] || 0) + 1;
console.log('  ' + Object.entries(dist2).sort().map(([k, v]) => `${k}:${v}`).join('  '));

/* ---------- 5：选项标签形态抽查 ---------- */
console.log('\n=== 选项标签形态抽查 ===');
const forms = all(`
  SELECT label, COUNT(*) c FROM exam_options GROUP BY label ORDER BY label
`);
console.log('  ' + forms.map((f) => `"${f.label}":${f.c}`).join('  '));

console.log(`\n结论：${bad === 0 ? '未发现结构性错误' : `发现 ${bad} 处问题（见上）`}`);
