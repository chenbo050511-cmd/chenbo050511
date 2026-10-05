'use strict';

/**
 * 审计真题文本的两类脏数据：
 *   ① 单词粘连（本该有空格的地方丢了空格）—— 用「超长字母串」来发现
 *   ② 正文里混进了试卷名称/页脚（"2019年6月英语四级真题" 之类）
 *
 * 用法：node tools/audit-exam-text.js
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'wordmaster.db'), { readOnly: true });
const query = (s, p = []) => db.prepare(s).all(...p);

/* ① 粘连：英语单词极少超过 18 个字母，超过基本就是粘了 */
const LONG = /[A-Za-z]{18,}/g;

/* ② 试卷名称/页脚：中文语境里的真题标识 */
const PAPER_NAME = /(\d{4}\s*年\s*\d{1,2}\s*月|[四六]级\s*真题|大学英语[四六]级|英语[四六]级(考试|真题)|真题\s*第?\s*[一二三四五六\d]\s*套|第\s*[一二三四五]\s*套\s*(答案|解析)?|pastpapers|\.cn\b|\d{4}\s*[.．]\s*\d{1,2}\s*[四六]级)/g;

const sources = [
  { name: '阅读短文', sql: "SELECT s.id, p.code, s.passage AS text FROM exam_sets s JOIN exam_papers p ON p.id=s.paper_id WHERE s.kind='reading'", col: 'text' },
  { name: '匹配段落', sql: "SELECT s.id, p.code, e.text FROM exam_paragraphs e JOIN exam_sets s ON s.id=e.set_id JOIN exam_papers p ON p.id=s.paper_id WHERE s.kind='matching'", col: 'text' },
  { name: '题干', sql: "SELECT s.id, p.code, q.stem AS text FROM exam_questions q JOIN exam_sets s ON s.id=q.set_id JOIN exam_papers p ON p.id=s.paper_id", col: 'text' },
  { name: '选项', sql: "SELECT s.id, p.code, o.text FROM exam_options o JOIN exam_questions q ON q.id=o.question_id JOIN exam_sets s ON s.id=q.set_id JOIN exam_papers p ON p.id=s.paper_id", col: 'text' },
];

let totalGlued = 0;
let totalPaper = 0;
const gluedSamples = [];
const paperSamples = [];
const byPaper = new Map();

for (const src of sources) {
  const rows = query(src.sql);
  let glued = 0;
  let paper = 0;
  for (const r of rows) {
    const text = String(r[src.col] || '');
    const longs = text.match(LONG);
    if (longs) {
      glued += longs.length;
      totalGlued += longs.length;
      if (gluedSamples.length < 12) gluedSamples.push({ where: src.name, code: r.code, hit: longs.slice(0, 3) });
      const k = `${src.name} ${r.code}`;
      byPaper.set(k, (byPaper.get(k) || 0) + longs.length);
    }
    const names = text.match(PAPER_NAME);
    if (names) {
      paper += names.length;
      totalPaper += names.length;
      if (paperSamples.length < 12) paperSamples.push({ where: src.name, code: r.code, hit: names.slice(0, 3), ctx: text.slice(Math.max(0, text.indexOf(names[0]) - 20), text.indexOf(names[0]) + 40) });
    }
  }
  console.log(`  ${src.name.padEnd(6)} ${rows.length} 条：粘连 ${glued} 处，含试卷名 ${paper} 处`);
}

console.log('');
console.log(`合计：粘连 ${totalGlued} 处，含试卷名 ${totalPaper} 处`);
console.log('');

if (gluedSamples.length) {
  console.log('=== 粘连样例 ===');
  for (const s of gluedSamples) {
    console.log(`  [${s.where}] ${s.code}: ${s.hit.join('  |  ')}`);
  }
  console.log('');
}

if (paperSamples.length) {
  console.log('=== 试卷名样例 ===');
  for (const s of paperSamples) {
    console.log(`  [${s.where}] ${s.code}: 命中「${s.hit.join('」「')}」`);
    console.log(`      上下文: …${s.ctx.replace(/\n/g, ' ')}…`);
  }
  console.log('');
}

if (byPaper.size) {
  console.log('=== 粘连最多的 10 处 ===');
  for (const [k, v] of [...byPaper.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${v}  ${k}`);
  }
}
