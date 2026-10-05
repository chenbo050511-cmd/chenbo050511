'use strict';
/*
 * 回归测试：口径一致性（「未学 / 已学 / 到期」三套判定在全项目必须一致）
 *
 * 背景——这里踩过三个坑，本脚本就是防止它们复发：
 *   1. 「学新词」只认 `p.word_id IS NULL`，于是给未学的词写笔记/收藏/暂缓
 *      （都会 INSERT 一行 status='new' 的 progress）就让这个词**永久消失**。
 *   2. 「累计学过」把这种空行也算进去，而状态四桶不算 → 两边差 1。
 *   3. 统计页各词库的 due 漏了排除暂缓 → 徽标 108、统计页 109。
 *
 * 用法：node tools/check-consistency.js [baseUrl] [book]
 * 建议指向**数据库副本**上跑的实例（本脚本只做只读 GET，不写数据）。
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const BOOK = process.argv[3] || 'kaoyan';

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  [ok]   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

async function getJson(path) {
  const r = await fetch(BASE + path);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${j && j.error ? j.error : ''}`);
  return j;
}

async function main() {
  console.log(`\n口径一致性回归  base=${BASE} book=${BOOK}\n`);

  /* ---------------- 1. 端点全部可达（防止 SQL 别名写错这类低级错误） ---------------- */
  console.log('1) 所有相关端点可达');
  const paths = [
    '/api/health',
    '/api/books',
    '/api/stats/overview',
    '/api/stats/stages',
    '/api/stats/books',
    '/api/stats/daily?days=7',
    '/api/stats/heatmap?days=7',
    '/api/stats/load?days=7',
    `/api/study/today?book=${BOOK}`,
    `/api/study/plan?book=${BOOK}&mode=review`,
    `/api/study/plan?book=${BOOK}&mode=new`,
    `/api/words?book=${BOOK}&status=new&size=1&page=1`,
    `/api/words?book=${BOOK}&status=due&size=1&page=1`,
    `/api/words?book=${BOOK}&status=suspended&size=1&page=1`,
    `/api/quiz/mistakes?book=${BOOK}`,
    `/api/quiz/leeches?book=${BOOK}`,
    '/api/settings/export',
    '/api/settings/export/logs',
  ];
  for (const p of paths) {
    try {
      await getJson(p);
      ok(true, `${p}`);
    } catch (e) {
      ok(false, `${p}`, e.message);
    }
  }

  /* ---------------- 2. 「未学」三处口径 ---------------- */
  console.log('\n2) 「未学」的口径');
  const [planNew, wordsNew, today, stages, overview, books] = await Promise.all([
    getJson(`/api/study/plan?book=${BOOK}&mode=new`),
    getJson(`/api/words?book=${BOOK}&status=new&size=1&page=1`),
    getJson(`/api/study/today?book=${BOOK}`),
    getJson('/api/stats/stages'),
    getJson('/api/stats/overview'),
    getJson('/api/books'),
  ]);

  ok(planNew.pools.newAvail === wordsNew.total,
    '学新词 newAvail == 浏览页「未学」筛选',
    `${planNew.pools.newAvail} vs ${wordsNew.total}`);
  ok(today.pools.newAvail === planNew.pools.newAvail,
    '今日页 newAvail == 学新词 newAvail',
    `${today.pools.newAvail} vs ${planNew.pools.newAvail}`);

  /* ---------------- 3. 状态四桶 == 去重总词数 ---------------- */
  console.log('\n3) 状态四桶之和 == 去重总词数');
  const s = stages.status;
  const sum = s.new + s.learning + s.reviewing + s.mastered;
  ok(sum === overview.word_total,
    'new+learning+reviewing+mastered == word_total',
    `${sum} vs ${overview.word_total}`);

  /* ---------------- 4. 「已学」各处口径 ---------------- */
  console.log('\n4) 「已学」的口径');
  ok(overview.started === overview.learning + overview.reviewing + overview.mastered,
    'overview.started == learning+reviewing+mastered',
    `${overview.started} vs ${overview.learning + overview.reviewing + overview.mastered}`);
  ok(stages.status.learning === overview.learning
     && stages.status.reviewing === overview.reviewing
     && stages.status.mastered === overview.mastered,
    'stages 的状态桶 == overview 的状态数',
    `stages(${s.learning}/${s.reviewing}/${s.mastered}) vs overview(${overview.learning}/${overview.reviewing}/${overview.mastered})`);
  ok(today.global.started === overview.started,
    'today.global.started == overview.started',
    `${today.global.started} vs ${overview.started}`);

  /* ---------------- 5. 「到期」各处口径 ---------------- */
  console.log('\n5) 「到期」的口径');
  const [planRev, wordsDue, statsBooks] = await Promise.all([
    getJson(`/api/study/plan?book=${BOOK}&mode=review`),
    getJson(`/api/words?book=${BOOK}&status=due&size=1&page=1`),
    getJson('/api/stats/books'),
  ]);
  const bk = books.find((b) => b.code === BOOK);
  const sbk = statsBooks.find((b) => b.code === BOOK);
  ok(bk.due === today.pools.dueTotal,
    'books.due == today.pools.dueTotal', `${bk.due} vs ${today.pools.dueTotal}`);
  ok(bk.due === planRev.dueNow,
    'books.due == plan.dueNow', `${bk.due} vs ${planRev.dueNow}`);
  ok(bk.due === wordsDue.total,
    'books.due == 浏览页「待复习」筛选', `${bk.due} vs ${wordsDue.total}`);
  ok(sbk.due === bk.due,
    'stats/books.due == books.due（暂缓词不再多算一个）', `${sbk.due} vs ${bk.due}`);

  /* ---------------- 6. 「正确率」口径必须唯一 ---------------- */
  console.log('\n6) 正确率与练习次数：今日页 vs 统计页');
  /*
   * 这两处曾经各写各的：统计页 `mode IN ('card','quiz')`，今日页「全部 logs」，
   * 于是同一份数据、同一个库，今日页显示 96%、统计页显示 94%。
   */
  ok(today.global.accuracy === overview.accuracy,
    'today.accuracy == overview.accuracy',
    `${today.global.accuracy}% vs ${overview.accuracy}%`);
  ok(today.global.totalReviews === overview.totalReviews,
    'today.totalReviews == overview.totalReviews',
    `${today.global.totalReviews} vs ${overview.totalReviews}`);

  /* ---------------- 7. 复习队列里的词确实都到期了 ---------------- */
  console.log('\n7) 复习队列内容自洽');
  const now = Date.now();
  const notDue = planRev.queue.filter((x) => x.due_at && new Date(x.due_at).getTime() > now);
  ok(notDue.length === 0, '队列里没有「还没到期」的词', `异常 ${notDue.length} 个`);
  const suspendedInQueue = planRev.queue.filter((x) => x.suspended);
  ok(suspendedInQueue.length === 0, '队列里没有已暂缓的词', `异常 ${suspendedInQueue.length} 个`);

  /* ---------------- 7. 阶段分布的档位数 == MAX_STAGE+1 ---------------- */
  console.log('\n8) 阶段标签档位');
  ok(stages.labels.length === stages.maxStage + 1,
    '标签数 == maxStage+1（不再有多余的空档）',
    `${stages.labels.length} vs ${stages.maxStage + 1}`);
  ok(stages.items.length === stages.labels.length, 'items 数与 labels 一致');

  /* ---------------- 8. 词库 started 不超过 total ---------------- */
  console.log('\n9) 词库统计合理性');
  for (const b of books) {
    ok(b.started <= b.total, `${b.code}: started(${b.started}) <= total(${b.total})`);
  }
  const pct = books.map((b) => b.percent);
  ok(pct.every((p) => Number.isFinite(p) && p >= 0 && p <= 100), '语库百分比都在 0..100',
    pct.join(','));

  console.log(`\n${'='.repeat(54)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`${'='.repeat(54)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n测试脚本出错：', err.message);
  console.error(`（确认服务已在 ${BASE} 运行）\n`);
  process.exit(2);
});
