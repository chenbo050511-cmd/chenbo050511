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
 *   node tools/repair-exam-text.js --check        # 断言已修好（不写库，未修好则退出码 1）
 *   WM_DB=D:/tmp/copy.db node tools/repair-exam-text.js   # 指向副本
 *
 * ⚠️ 为什么必须有 --check：
 *   本工具是**整条重建流水线的最后一步**，因为 tools/clean-exam-text.py
 *   会重写 exam_sets.passage / exam_paragraphs.text 等列 ——
 *   一旦有人重跑那条流水线却忘了跑这一步，本工具修好的内容就会**静默丢失**，
 *   而且没有任何报错。--check 就是用来抓这种情况的（见 tools/run-tests.js）。
 *
 * 设计取舍（为什么不用正则自动扫）：
 *   自动识别「小写词里夹大写」的假阳性太高 —— `vitamin C`、`iPhone`、
 *   `McDonald`、`U.S.` 都会被误伤。所以这里用**人工核验过的修复清单**，
 *   每条都写明 before/after，跑之前能看到完整 diff。
 *   这与 tools/clean-exam-text.py 的思路一致（保守 + 白名单），
 *   而不是与它重复：那个管「丢空格粘连」，这个管「乱入大写 + 中文批注后缺空格」。
 */

const path = require('node:path');
const fs = require('node:fs');

const db = require('../src/db');

const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');

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

  /* ===================================================================
   * 第二批：丢词边界 / 丢空格（对照 tools/_raw/exam/pdf/ 的原始 PDF 核验过）
   *
   * 这一批的特点是**整段空格都丢了**（PDF 文本层的问题），
   * 所以是「单词粘连」而不是「字符损坏」—— 每个单词本身都是对的，
   * 只是词与词之间没有空格。因此可以安全地按 PDF 原文还原。
   * =================================================================== */

  /* --- set#95《Why Do Americans Work So Much?》(2024-06-CET4-1) ---
     PDF 原文：According to Benjamin M. Friedman, an economist at Harvard,
               the U.S. economy is right on track to reach Keynes's eight-fold(八倍) multiple by 2029.
               That is a century after the last data Keynes would have had access to. */
  { table: 'exam_sets', col: 'passage', from: 'AccordingtoBenjaminM.Friedman', to: 'According to Benjamin M. Friedman' },
  { table: 'exam_sets', col: 'passage', from: 'aneconomistatHarvard', to: 'an economist at Harvard' },
  { table: 'exam_sets', col: 'passage', from: 'theU.S.economyisrightontracktoreachKeynes', to: 'the U.S. economy is right on track to reach Keynes' },
  { table: 'exam_sets', col: 'passage', from: 'last dataKeynes wouldhave', to: 'last data Keynes would have' },
  { table: 'exam_sets', col: 'passage', from: 'standardofliving', to: 'standard of living' },
  { table: 'exam_sets', col: 'passage', from: 'effectiveopportunities', to: 'effective opportunities' },
  { table: 'exam_paragraphs', col: 'text', from: 'last dataKeynes would have', to: 'last data Keynes would have' },

  /* --- set#98《How to better work towards long-term goals》(2024-06-CET4-2) ---
     PDF 原文：your brain registers that person in ways similar to how it would register
               Taylor Swift or the mailman. Understood in that way, saving for retirement is
               the equivalent of giving money away to someone else entirely */
  { table: 'exam_sets', col: 'passage', from: 'would registerTaylor Swift', to: 'would register Taylor Swift' },
  { table: 'exam_sets', col: 'passage', from: 'the equivalentofgiving', to: 'the equivalent of giving' },
  { table: 'exam_sets', col: 'passage', from: 'someone elseentirely', to: 'someone else entirely' },
  { table: 'exam_paragraphs', col: 'text', from: 'registerTaylor Swift', to: 'register Taylor Swift' },

  /* --- set#149《The battle over bike lanes needs a mindset shift》(2025-12-CET4-1) ---
     PDF 原文：who have hung around since before the neighborhood became what it is today,"
               he adds. Driving around town in a car is so normal to them that cycling seems
               weird and unusual—despite its boost from Covid, when bike sales exploded by 75 percent. */
  { table: 'exam_sets', col: 'passage', from: 'beforetheneighborhoodbecame', to: 'before the neighborhood became' },
  { table: 'exam_sets', col: 'passage', from: 'what itis today', to: 'what it is today' },
  { table: 'exam_sets', col: 'passage', from: ',"headds.', to: '," he adds.' },
  { table: 'exam_sets', col: 'passage', from: 'Driving aroundtown', to: 'Driving around town' },
  { table: 'exam_sets', col: 'passage', from: 'thatcyclingseems', to: 'that cycling seems' },
  { table: 'exam_sets', col: 'passage', from: '75percent', to: '75 percent' },
  { table: 'exam_paragraphs', col: 'text', from: '75percent', to: '75 percent' },

  /* --- set#43《What happens when a language has no words for numbers?》(2021-06-CET4-2) ---
     PDF 原文：This and many other experiments have led to a simple conclusion. When people
               lack number words, they struggle to make quantitative distinctions…
     注意：这一处源 PDF 本身就带乱码（见文件末尾的 KNOWN_DAMAGE），
     这里只修「能确定的部分」。 */
  { table: 'exam_sets', col: 'passage', from: 'otherexiteriments', to: 'other experiments' },
  { table: 'exam_paragraphs', col: 'text', from: 'otherexiteriments', to: 'other experiments' },

  /* --- set#65《The hidden costs colleges don't want you to know about》(2022-12-CET4-1) ---
     这两个 PDF 不在 tools/_raw/exam/pdf/ 里，无法对照核验，
     所以只做**最保守**的切分（纯单词边界，不猜任何字符）。 */
  { table: 'exam_sets', col: 'passage', from: 'prescriptionmedications', to: 'prescription medications' },
  { table: 'exam_sets', col: 'passage', from: 'tryingdesperatelyto', to: 'trying desperately to' },

  /* --- set#74《Hyphenating your last name after marriage?》(2023-03-CET4-1) ---
     PDF 缺失。原文显然应是 "happily married, hopefully for the rest of your lives"，
     但缺了哪个词无法核验，所以只切分，不补词。 */
  { table: 'exam_sets', col: 'passage', from: 'marriedhopefully', to: 'married, hopefully' },

  /* --- A2 类：数字与单词之间丢空格（纯机械修复，无歧义）--- */
  { table: 'exam_sets', col: 'passage', from: 'year2000', to: 'year 2000' },
  { table: 'exam_paragraphs', col: 'text', from: 'year2000', to: 'year 2000' },
  { table: 'exam_sets', col: 'passage', from: '20million', to: '20 million' },
  { table: 'exam_sets', col: 'passage', from: '7billion', to: '7 billion' },
  { table: 'exam_sets', col: 'passage', from: '1970was', to: '1970 was' },
  { table: 'exam_sets', col: 'passage', from: '240employees', to: '240 employees' },
  { table: 'exam_paragraphs', col: 'text', from: '240employees', to: '240 employees' },
  { table: 'exam_sets', col: 'passage', from: "neededin interdisciplinary", to: 'needed in interdisciplinary' },
  { table: 'exam_options', col: 'text', from: "neededin interdisciplinary", to: 'needed in interdisciplinary' },

  /* ===================================================================
   * 第三批：中文批注右括号后缺空格（2024-06 / 2025-12 / 2026 那几套）
   *
   * 这些卷的 PDF 里带中文注释，如 `(八倍)`、`(理发师)`、`(中位数的)`。
   * 注释本身完好，只是**后面紧接着英文而没有空格**，读起来会粘在一起。
   * 这一批是纯排版修复，不涉及任何内容判断。
   * =================================================================== */
  { table: 'exam_sets', col: 'passage', from: ')multiple by2029', to: ') multiple by 2029' },
  { table: 'exam_sets', col: 'passage', from: ')American worker', to: ') American worker' },
  { table: 'exam_sets', col: 'passage', from: 'roles)in private', to: 'roles) in private' },
  { table: 'exam_sets', col: 'passage', from: 'prosperity(繁荣)Keynes', to: 'prosperity(繁荣) Keynes' },
  { table: 'exam_sets', col: 'passage', from: 'taboo(禁总)and', to: 'taboo(禁总) and' },
  { table: 'exam_sets', col: 'passage', from: 'selves)suffers', to: 'selves) suffers' },
  { table: 'exam_sets', col: 'passage', from: 'procrastination(拖延)through', to: 'procrastination(拖延) through' },
  { table: 'exam_sets', col: 'passage', from: 'gratifcation (满足感)to', to: 'gratifcation (满足感) to' },
  { table: 'exam_sets', col: 'passage', from: 'tactics(手段)above', to: 'tactics(手段) above' },
  { table: 'exam_sets', col: 'passage', from: 'selftrumps(战胜)future self', to: 'self trumps(战胜) future self' },
  { table: 'exam_sets', col: 'passage', from: 'tacks(大头钉)on', to: 'tacks(大头钉) on' },
  { table: 'exam_sets', col: 'passage', from: 'hairdresser(理发师)in', to: 'hairdresser(理发师) in' },
  { table: 'exam_sets', col: 'passage', from: 'rollout(推出)of', to: 'rollout(推出) of' },
  { table: 'exam_sets', col: 'passage', from: 'reckless(鲁莽的)to', to: 'reckless(鲁莽的) to' },

  /* --- 弯引号 / 逗号后缺空格（这几处原文用的是直引号） --- */
  { table: 'exam_sets', col: 'passage', from: 'a nightmare,"one shouted', to: 'a nightmare," one shouted' },

  /* --- 其他丢空格 --- */
  { table: 'exam_sets', col: 'passage', from: 'sun-kissed flowersthen', to: 'sun-kissed flowers then' },
  { table: 'exam_sets', col: 'passage', from: 'an additional s 1,2oo', to: 'an additional $1,200' },
];

/* 明确**不修**的（合法英文，留着是防以后有人"顺手"改掉） */
const DO_NOT_FIX = [
  'vitamin C and                     —— 维生素 C 是正确写法',
  'School of Medicine / of California / of Ford —— 合法的机构名（of + 专有名词）',
  'misunderstandings / environmentalists / interdisciplinary / multidisciplinary —— 都是合法单词',
  'break-up / head-on / hands-on / face-to-face 等 —— 正常的连字符复合词',
];

/*
 * ⚠️ 已知无法修复的损坏（源数据自带，不是本工具能解决的）
 *
 * 2021-06-CET4-2 / CET4-3 那几套卷的 PDF 文本层里混着**中文批注**，
 * 被 pdfplumber 用错误的字体映射解成了乱码，横插进英文正文：
 *
 *   cognitive ( -iA � {JI.;) benefits         ← 本该是个中文括号注释
 *   abilities-are ll! J� 2021 1j::. 6 JJ 4 related to
 *   can 信 ��t in �h� _\\"_ay_ _�f buildin� a real se��!'!_ b_elong
 *   Matthew effect� fo 微 sp1red6- y ilie Bible's-wisdom diaf fo
 *   hav-e led to�a simple�conclusion�J\lhe�peopl�dQD.QtJ1av-e�umber
 *
 * 实测：**PDF 本身就含 82 个替换字符**（第 8 页占了 54 个），
 * source_v2.db 的 question_group.passage 共 55 个、question.content 4 个 ——
 * 也就是说源库是**忠实记录**了 PDF 的乱码，不是构建过程弄坏的。
 * 重建 / 清洗都无法修好它，唯一的出路是换一份干净的 PDF 或手工重录。
 *
 * 影响面（实测）：24 行 —— 正文 6 行（set#41–46）、段落 10 行、
 * 阅读分段 3 行、题干 2 行、选项 3 行。都集中在 2021-06-CET4 那几套。
 *
 * 本工具**不碰**这些乱码 —— 因为无法知道原文是什么，猜就是编造。
 */
const KNOWN_DAMAGE = [
  '2021-06-CET4-1 / -2 / -3：24 行正文含中文批注被误解成的乱码，无法修复',
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
const hitCount = plan.reduce((a, b) => a + b.hits.length, 0);

/* ---- --check：断言已修好，不写库 ---- */
if (CHECK) {
  if (!hitCount) {
    console.log(`\n[ok] 真题文本修复已应用（${FIXES.length} 条清单全部无残留）\n`);
    process.exit(0);
  }
  console.log(`\n[FAIL] 有 ${hitCount} 处修复**丢失了** —— 数据库里又出现了清单里的坏文本。`);
  console.log('       最可能的原因：重跑了重建流水线，但没跑最后这一步。\n');
  for (const p of plan) {
    console.log(`  ${p.table}.${p.col}  #${p.hits.join(', #')}   "${p.from}"`);
  }
  console.log('\n  修法：node tools/repair-exam-text.js --write\n');
  process.exit(1);
}

console.log(`\n真题文本修复${WRITE ? '' : '（预演，未写库）'}\n`);
console.log(`清单 ${FIXES.length} 条，命中 ${plan.length} 条，共 ${hitCount} 处\n`);

if (!plan.length) {
  console.log('  没有需要修的 —— 清单里的模式都已不存在（要么已经修过，要么又退回去了）。\n');
  process.exit(0);
}

for (const p of plan) {
  console.log(`  ${p.table}.${p.col}  #${p.hits.join(', #')}`);
  console.log(`      "${p.from}"`);
  console.log(`   →  "${p.to}"`);
}

console.log('\n明确不动的（防止以后被"顺手修掉"）：');
DO_NOT_FIX.forEach((x) => console.log(`  · ${x}`));

console.log('\n已知无法修复的损坏（源 PDF 自带，本工具不碰）：');
KNOWN_DAMAGE.forEach((x) => console.log(`  ! ${x}`));

if (!WRITE) {
  console.log('\n（预演模式。确认上面每条都对，再加 --write 写入）\n');
  process.exit(0);
}

/* ---- 写入前备份 ---- */
const snapshot = require('../src/dbsnapshot');
const DB_FILE = db.DB_FILE;
const bak = `${DB_FILE}.before-repair-text`;
if (!fs.existsSync(bak)) {
  const r = snapshot.snapshot(DB_FILE, bak);
  console.log(`\n  已备份 → ${path.basename(bak)}（${r.mode === 'single' ? 'WAL 已合并' : '含 WAL/SHM 三文件'}）`);
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
