'use strict';

/**
 * 清洗后的最终校验：
 *   ① 全库还有没有试卷名/页脚残留
 *   ② 还有没有「不在词典里、也不是白名单」的长 token（= 可能漏掉的粘连）
 *   ③ 短文分段与短文正文是否仍然一致（清洗不能把两者弄脱节）
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'wordmaster.db'), { readOnly: true });
const all = (s) => db.prepare(s).all();

/* ① 试卷名 */
const NOISE = /(\d{4}\s*年\s*\d{1,2}\s*月|[四六]级\s*真题|大学英语[四六]级|英语[四六]级(考试|真题)|真题\s*第?\s*[一二三四五六\d]\s*套|第\s*[一二三四五]\s*套|pastpapers|\.cn\b|页\s*码)/;
let noise = 0;
const targets = [
  ['短文', 'SELECT passage AS t FROM exam_sets WHERE kind = \'reading\''],
  ['分段', 'SELECT text AS t FROM exam_reading_paragraphs'],
  ['段落', 'SELECT text AS t FROM exam_paragraphs'],
  ['题干', 'SELECT stem AS t FROM exam_questions'],
  ['选项', 'SELECT text AS t FROM exam_options'],
];
for (const [label, sql] of targets) {
  for (const r of all(sql)) {
    if (NOISE.test(r.t || '')) { noise++; if (noise <= 5) console.log(`  ✗ ${label}: ${(r.t || '').slice(0, 70)}`); }
  }
}
console.log(`① 试卷名/页脚残留：${noise === 0 ? '✓ 0 处' : noise + ' 处'}`);

/* ② 长 token */
const long = new Map();
for (const [, sql] of targets) {
  for (const r of all(sql)) {
    for (const w of String(r.t || '').match(/[A-Za-z]{18,}/g) || []) long.set(w, (long.get(w) || 0) + 1);
  }
}
console.log(`② 18 字符以上的 token 共 ${long.size} 个（应当都是合法长词）：`);
for (const [w, c] of [...long.entries()].sort()) console.log(`     ${w}  ×${c}`);

/* ③ 分段与正文一致性 */
const sets = all(`
  SELECT s.id, s.passage AS passage FROM exam_sets s
   WHERE s.kind = 'reading' AND EXISTS (SELECT 1 FROM exam_reading_paragraphs p WHERE p.set_id = s.id)
`);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let bad = 0;
for (const s of sets) {
  const paras = all('SELECT text FROM exam_reading_paragraphs WHERE set_id = ? ORDER BY seq', null)
    .filter(() => false); // 占位，下面用带参数查询
  const rows = db.prepare('SELECT text FROM exam_reading_paragraphs WHERE set_id = ? ORDER BY seq').all(s.id);
  const joined = norm(rows.map((r) => r.text).join(' '));
  const src = norm(s.passage);
  if (!joined || !src) continue;
  // 分段的字符应当几乎完全覆盖正文
  const cover = joined.length / src.length;
  if (cover < 0.93 || cover > 1.07) {
    bad++;
    if (bad <= 5) console.log(`  ✗ set#${s.id} 分段/正文长度比 ${cover.toFixed(3)}`);
  }
}
console.log(`③ 分段与正文一致性：检查 ${sets.length} 组，异常 ${bad} 组${bad === 0 ? ' ✓' : ''}`);

/* ④ 总览 */
const stat = db.prepare(`SELECT
  (SELECT COUNT(*) FROM exam_sets WHERE kind='reading') AS r,
  (SELECT COUNT(*) FROM exam_paragraphs) AS mp,
  (SELECT COUNT(*) FROM exam_questions) AS q,
  (SELECT COUNT(*) FROM exam_options) AS o`).get();
console.log(`④ 规模：阅读组 ${stat.r}，匹配段落 ${stat.mp}，题目 ${stat.q}，选项 ${stat.o}`);
