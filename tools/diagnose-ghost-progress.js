'use strict';
/* 只读：深挖那个幽灵行是怎么产生的，以及 reps 的真实语义 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const DB = process.env.WM_DB || path.join(__dirname, '..', 'data', 'wordmaster.db');
const d = new DatabaseSync(DB, { readOnly: true });

console.log('=== 幽灵行 #4958 staggering 的完整内容 ===');
const row = d.prepare('SELECT * FROM progress WHERE word_id = 4958').get();
console.log(JSON.stringify(row, null, 2));

console.log('\n它属于哪些词库:');
d.prepare('SELECT b.code FROM book_words bw JOIN books b ON b.id=bw.book_id WHERE bw.word_id=4958').all()
  .forEach((r) => console.log('  ' + r.code));

console.log('\n它有没有任何 logs 流水:');
const logs = d.prepare('SELECT mode, rating, correct, day FROM logs WHERE word_id=4958').all();
console.log(logs.length ? logs : '  （没有任何流水）');

console.log('\n=== reps 的真实语义核查 ===');
console.log('progress 里 reps>0 的词数:', d.prepare('SELECT COUNT(*) c FROM progress WHERE reps>0').get().c);
console.log('\n对比：某个词的 reps 与它 card_done 流水的条数');
const cmp = d.prepare(`
  SELECT p.word_id, w.spelling, p.reps,
         (SELECT COUNT(*) FROM logs l WHERE l.word_id=p.word_id AND l.mode='card_done') AS card_done_cnt,
         (SELECT COUNT(*) FROM logs l WHERE l.word_id=p.word_id) AS all_logs
    FROM progress p JOIN words w ON w.id=p.word_id
   WHERE p.reps > 0
   ORDER BY p.reps DESC LIMIT 8
`).all();
for (const r of cmp) {
  console.log(`  ${r.spelling.padEnd(16)} reps=${String(r.reps).padEnd(4)} card_done流水=${String(r.card_done_cnt).padEnd(4)} 全部流水=${r.all_logs}`);
}

console.log('\n=== 幽灵行的总数（全库口径）===');
const g = d.prepare(`
  SELECT COUNT(*) c FROM progress
   WHERE COALESCE(status,'new')='new' AND COALESCE(reps,0)=0 AND first_seen_at IS NULL
`).get().c;
console.log('  幽灵行:', g);
console.log('  其中带 favorite/marked/note/suspended 任一标记的:',
  d.prepare(`SELECT COUNT(*) c FROM progress
              WHERE COALESCE(status,'new')='new' AND COALESCE(reps,0)=0 AND first_seen_at IS NULL
                AND (COALESCE(favorite,0)=1 OR COALESCE(marked,0)=1
                     OR COALESCE(note,'')<>'' OR COALESCE(suspended,0)=1)`).get().c);
d.close();
