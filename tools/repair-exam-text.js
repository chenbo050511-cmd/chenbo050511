'use strict';
/*
 * 修真题文本里的**孤立乱入大写字母**（OCR / PDF 提取残留）。
 *
 * 这类噪声长这样：一个本该是纯小写的单词中间，多出一个大写字母，
 * 或者两个小写词之间夹了一个孤立大写字母：
 *
 *   tYhem        → them            （them 里插了个 Y）
 *   coMre        → core
 *   conflYicting → conflicting
 *   scientisMts  → scientists
 *   buMck        → buck
 *   social M lives  → social lives
 *   teaching U students → teaching students
 *   whether O they → whether they
 *
 * 成因：这一组（set#42）原文的段首标记是 `A)` `B)` … `J)`，
 * PDF 提取时那些大写字母被随机插进了正文。
 *
 * ⚠️ 用法：默认是**预演**，只打印会改什么，不写库。确认无误后再加 --write。
 *
 *   node tools/repair-exam-text.js                # 预演
 *   node tools/repair-exam-text.js --write        # 写库（会先自动备份）
 *   WM_DB=D:/tmp/copy.db node tools/repair-exam-text.js   # 指向副本
 *
 * 设计取舍（为什么不用正则自动扫）：
 *   自动识别「小写词里夹大写」的假阳性太高 —— `vitamin C`、`iPhone`、
 *   `McDonald`、`U.S.` 都会被误伤。所以这里用**人工核验过的修复清单**，
 *   每条都写明 before/after，跑之前能看到完整 diff。
 *   这与 tools/clean-exam-text.py 的思路一致（保守 + 白名单），
 *   而不是与它重复：那个管「丢空格粘连」，这个管「乱入大写」。
 */

const path = require('node:path');
const fs = require('node:fs');

const db = require('../src/db');

const WRITE = process.argv.includes('--write');

/*
 * 修复清单。每条：{ 表, 列, 定位串, 替换 }。
 *
 * 「定位串」必须**足够独特**，否则会误伤别处；替换里写明期望的最终文本。
 * 这些都是逐条对着真实数据核验过的（不是猜的）。
 */
const FIXES = [
  /* --- set#42「The start of high school doesn't have to be stressful」--- */
  // 段首标记 A)–J) 被随机插入正文的那些大写字母
  { table: 'exam_sets', col: 'passage', from: 'social M lives', to: 'social lives' },
  { table: 'exam_sets', col: 'passage', from: 'teaching U students', to: 'teaching students' },
  { table: 'exam_sets', col: 'passage', from: 'whether O they', to: 'whether they' },
  { table: 'exam_sets', col: 'passage', from: 'tYhem', to: 'them' },
  { table: 'exam_paragraphs', col: 'text', from: 'social M lives', to: 'social lives' },
  { table: 'exam_paragraphs', col: 'text', from: 'teaching U students', to: 'teaching students' },
  { table: 'exam_paragraphs', col: 'text', from: 'whether O they', to: 'whether they' },
  { table: 'exam_paragraphs', col: 'text', from: 'tYhem', to: 'them' },

  /* --- set#41 --- */
  { table: 'exam_sets', col: 'passage', from: 'prepare Y students', to: 'prepare students' },

  /* --- set#46「Science of setbacks」--- */
  { table: 'exam_sets', col: 'passage', from: 'conflYicting', to: 'conflicting' },
  { table: 'exam_sets', col: 'passage', from: 'scientisMts', to: 'scientists' },
  { table: 'exam_sets', col: 'passage', from: 'buMck', to: 'buck' },
  { table: 'exam_paragraphs', col: 'text', from: 'conflYicting', to: 'conflicting' },
  { table: 'exam_paragraphs', col: 'text', from: 'scientisMts', to: 'scientists' },
  { table: 'exam_paragraphs', col: 'text', from: 'buMck', to: 'buck' },
  { table: 'exam_paragraphs', col: 'text', from: 'toY pile', to: 'to pile' },

  /* --- set#43 --- */
  { table: 'exam_sets', col: 'passage', from: 'than the O number', to: 'than the number' },
  { table: 'exam_paragraphs', col: 'text', from: 'than the O number', to: 'than the number' },

  /* --- set#118 / set#42 里那个 coMre --- */
  { table: 'exam_sets', col: 'passage', from: 'coMre', to: 'core' },
  { table: 'exam_paragraphs', col: 'text', from: 'coMre', to: 'core' },

  /* --- 那一处被旧脚本弄坏的：M + any will do well --- */
  { table: 'exam_paragraphs', col: 'text', from: 'Many will do well. U But', to: 'Many will do well. But' },
];

/* 明确**不修**的（合法英文，留着是防以后有人"顺手"改掉） */
const DO_NOT_FIX = [
  'vitamin C and                     —— 维生素 C 是正确写法',
  'School of Medicine / of California / of Ford —— 合法的机构名（of + 专有名词）',
  'aneconomistatHarvard 等丢空格的粘连 —— 属 clean-exam-text.py 的职责，不在本工具范围',
];

function survey() {
  const plan = [];
  for (const f of FIXES) {
    const rows = db.query(`SELECT id, ${f.col} AS body FROM ${f.table}`);
    const hits = rows.filter((r) => typeof r.body === 'string' && r.body.includes(f.from));
    if (hits.length) plan.push({ ...f, hits: hits.map((h) => h.id) });
  }
  return plan;
}

const plan = survey();

console.log(`\n真题文本修复${WRITE ? '' : '（预演，未写库）'}\n`);
console.log(`清单 ${FIXES.length} 条，命中 ${plan.length} 条，共 ${plan.reduce((a, b) => a + b.hits.length, 0)} 处\n`);

if (!plan.length) {
  console.log('  没有需要修的 —— 清单里的模式都已不存在（可能已经修过）。\n');
  process.exit(0);
}

for (const p of plan) {
  console.log(`  ${p.table}.${p.col}  #${p.hits.join(', #')}`);
  console.log(`      "${p.from}"`);
  console.log(`   →  "${p.to}"`);
}

console.log('\n明确不动的（防止以后被"顺手修掉"）：');
DO_NOT_FIX.forEach((x) => console.log(`  · ${x}`));

if (!WRITE) {
  console.log('\n（预演模式。确认上面每条都对，再加 --write 写入）\n');
  process.exit(0);
}

/* ---- 写入前备份 ---- */
const DB_FILE = db.DB_FILE;
const bak = `${DB_FILE}.before-repair-text`;
if (!fs.existsSync(bak)) {
  fs.copyFileSync(DB_FILE, bak);
  console.log(`\n  已备份 → ${path.basename(bak)}`);
} else {
  console.log(`\n  备份已存在（保留最早那份）→ ${path.basename(bak)}`);
}

db.transaction(() => {
  let n = 0;
  for (const p of plan) {
    for (const id of p.hits) {
      const row = db.queryOne(`SELECT ${p.col} AS body FROM ${p.table} WHERE id = ?`, [id]);
      if (!row || typeof row.body !== 'string') continue;
      // 只替换第一处，避免同一处文本被重复替换
      const next = row.body.replace(p.from, p.to);
      if (next === row.body) continue;
      db.execute(`UPDATE ${p.table} SET ${p.col} = ? WHERE id = ?`, [next, id]);
      n++;
    }
  }
  console.log(`  已写入 ${n} 条改动`);
});

/* ---- 写后自检：确认清单里的模式都消失了 ---- */
const left = survey();
console.log(`  写后复查：剩余命中 ${left.reduce((a, b) => a + b.hits.length, 0)} 处${left.length ? ' ★ 仍有残留' : ' ✓'}`);
