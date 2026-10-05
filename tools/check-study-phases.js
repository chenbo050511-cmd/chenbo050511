'use strict';
/*
 * 三阶段协议回归（/api/study/answer 的 phase: first / repeat / pass）
 *
 * 为什么需要它：前端曾经固定发 'legacy'，于是服务端的 first/repeat 分支
 * 全是死代码，连带三个后果：
 *   · 每点一次反馈就排期一次、中间态被反复写入
 *   · 重复作答也算进正确率（与「只算首答」的承诺矛盾）
 *   · 「今日已复习」只认 card_done，而 legacy 写的是 card → **恒为 0**
 *
 * 这个脚本会**写数据**，只能指向数据库副本！
 * 用法：node tools/check-study-phases.js [baseUrl] [book]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3980';
const BOOK = process.argv[3] || 'cet4';

let pass = 0;
let fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  [ok]   ${l}${e ? '  ' + e : ''}`); }
  else { fail++; console.log(`  [FAIL] ${l}${e ? '  ' + e : ''}`); }
};
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

/** 今天各口径的快照 */
async function snapshot() {
  const [today, plan, w] = await Promise.all([
    get(`/api/study/today?book=${BOOK}`),
    get(`/api/study/plan?book=${BOOK}&mode=review`),
    get(`/api/stats/overview`),
  ]);
  return { today, plan, ov: w };
}

(async () => {
  console.log(`\n三阶段协议回归  base=${BASE} book=${BOOK}\n`);

  /* ---------------- 1. first 不排期 ---------------- */
  console.log('1) first 阶段：只记流水，不排期');
  const plan0 = await get(`/api/study/plan?book=${BOOK}&mode=review`);
  ok(plan0.queue.length > 0, '复习队列里有词可测', `队列 ${plan0.queue.length}`);
  const target = plan0.queue[0];
  const before = await get(`/api/words/${target.id}`);
  const stageBefore = before.progress ? before.progress.stage : null;
  const dueBefore = before.progress ? before.progress.due_at : null;
  const reviewedBefore = (await snapshot()).today.counters.reviewed;
  const reviewsBefore = (await get('/api/stats/overview')).totalReviews;

  const f = await post('/api/study/answer', {
    wordId: target.id, rating: 'unknown', bookCode: BOOK, phase: 'first',
  });
  ok(f.status === 200, 'first 提交被接受', `status=${f.status}`);
  ok(f.data.scheduled === false, '响应里 scheduled=false（明确表示没排期）');

  const afterFirst = await get(`/api/words/${target.id}`);
  ok((afterFirst.progress ? afterFirst.progress.stage : null) === stageBefore,
    '★ stage 没有变化（排期被延后）', `${stageBefore} → ${afterFirst.progress && afterFirst.progress.stage}`);
  ok((afterFirst.progress ? afterFirst.progress.due_at : null) === dueBefore,
    '★ due_at 没有变化');

  const ovAfterFirst = await get('/api/stats/overview');
  ok(ovAfterFirst.totalReviews === reviewsBefore + 1,
    'first 记了一条流水（进正确率）', `${reviewsBefore} → ${ovAfterFirst.totalReviews}`);
  ok((await snapshot()).today.counters.reviewed === reviewedBefore,
    'first 之后「今日已复习」不变（还没过关）',
    `${reviewedBefore} → ${(await snapshot()).today.counters.reviewed}`);

  /* ---------------- 2. repeat 不进正确率 ---------------- */
  console.log('\n2) repeat 阶段：只记流水，不进正确率、不进打卡');
  const ovBeforeRepeat = await get('/api/stats/overview');
  const r1 = await post('/api/study/answer', {
    wordId: target.id, rating: 'unknown', bookCode: BOOK, phase: 'repeat',
  });
  ok(r1.status === 200 && r1.data.recorded === 'repeat', 'repeat 被接受并标记为 repeat');
  const ovAfterRepeat = await get('/api/stats/overview');
  ok(ovAfterRepeat.totalReviews === ovBeforeRepeat.totalReviews,
    '★ repeat **不**增加正确率分母', `${ovBeforeRepeat.totalReviews} → ${ovAfterRepeat.totalReviews}`);
  const afterRepeat = await get(`/api/words/${target.id}`);
  ok((afterRepeat.progress ? afterRepeat.progress.stage : null) === stageBefore,
    '★ repeat 也没有改 stage');

  /* ---------------- 3. pass 才排期 ---------------- */
  console.log('\n3) pass 阶段：这时候才排期');
  const reviewedBeforePass = (await snapshot()).today.counters.reviewed;
  const p = await post('/api/study/answer', {
    wordId: target.id, rating: 'known', bookCode: BOOK, phase: 'pass', firstRating: 'known',
  });
  ok(p.status === 200, 'pass 提交被接受', `status=${p.status}`);
  ok(p.data.firstRating === 'unknown',
    '★ 排期用的是**服务端记录的 first=unknown**（不是我传的 known）',
    `firstRating=${p.data.firstRating}`);
  ok(p.data.effective === 'unknown', 'effective=unknown（首答不认识 → 回明天）',
    `effective=${p.data.effective}`);

  const afterPass = await get(`/api/words/${target.id}`);
  ok(afterPass.progress.stage === 0, '★ stage 回到 0（明天再来）',
    `stage=${afterPass.progress.stage}`);
  ok(afterPass.progress.unknown_count === (before.progress ? before.progress.unknown_count : 0) + 1,
    'unknown_count +1（按首答记）',
    `${before.progress && before.progress.unknown_count} → ${afterPass.progress.unknown_count}`);

  const reviewedAfterPass = (await snapshot()).today.counters.reviewed;
  ok(reviewedAfterPass === reviewedBeforePass + 1,
    '★ 「今日已复习」+1（这是原来恒为 0 的那个数）',
    `${reviewedBeforePass} → ${reviewedAfterPass}`);

  /* ---------------- 4. pass 不能伪造首答 ---------------- */
  console.log('\n4) pass 时伪造 firstRating 必须无效');
  const plan2 = await get(`/api/study/plan?book=${BOOK}&mode=review`);
  const t2 = plan2.queue.find((x) => x.id !== target.id) || plan2.queue[0];
  await post('/api/study/answer', {
    wordId: t2.id, rating: 'unknown', bookCode: BOOK, phase: 'first',
  });
  // 故意在 pass 上说「我第一次是认识的」
  const forged = await post('/api/study/answer', {
    wordId: t2.id, rating: 'known', bookCode: BOOK, phase: 'pass', firstRating: 'known',
  });
  ok(forged.data.firstRating === 'unknown',
    '★ 伪造 firstRating=known 被忽略，仍用服务端的 unknown',
    `firstRating=${forged.data.firstRating}`);
  const t2after = await get(`/api/words/${t2.id}`);
  ok(t2after.progress.stage === 0, '★ 排期按真实的「不认识」算（stage=0）',
    `stage=${t2after.progress.stage}`);

  /* ---------------- 5. 没有首答记录时 pass 必须拒绝 ---------------- */
  console.log('\n5) 没有首答记录时 pass 必须 409（不能瞎猜）');
  const plan3 = await get(`/api/study/plan?book=${BOOK}&mode=review`);
  const t3 = plan3.queue.find((x) => x.id !== target.id && x.id !== t2.id) || plan3.queue[0];
  const t3before = await get(`/api/words/${t3.id}`);
  const t3StageBefore = t3before.progress ? t3before.progress.stage : null;
  const orphan = await post('/api/study/answer', {
    wordId: t3.id, rating: 'known', bookCode: BOOK, phase: 'pass', firstRating: 'known',
  });
  ok(orphan.status === 409, '★ 直接 pass（没先 first）→ 409', `status=${orphan.status}`);
  ok(orphan.data && orphan.data.reason === 'first-rating-missing',
    'reason=first-rating-missing', JSON.stringify(orphan.data && orphan.data.reason));
  const t3after = await get(`/api/words/${t3.id}`);
  ok((t3after.progress ? t3after.progress.stage : null) === t3StageBefore,
    '★ 被拒绝的 pass 没有改动 stage', `${t3StageBefore} → ${t3after.progress && t3after.progress.stage}`);

  /* ---------------- 6. 一遍就过：first(known)+pass 正确推进 ---------------- */
  console.log('\n6) 一遍就过：first(known) → pass，间隔大步推进');
  const plan4 = await get(`/api/study/plan?book=${BOOK}&mode=review`);
  const t4 = plan4.queue.find((x) => ![target.id, t2.id, t3.id].includes(x.id));
  if (t4) {
    const b4 = await get(`/api/words/${t4.id}`);
    const stage4 = b4.progress ? b4.progress.stage : 0;
    await post('/api/study/answer', {
      wordId: t4.id, rating: 'known', bookCode: BOOK, phase: 'first',
    });
    const done4 = await post('/api/study/answer', {
      wordId: t4.id, rating: 'known', bookCode: BOOK, phase: 'pass', firstRating: 'known',
    });
    ok(done4.data.firstRating === 'known', 'firstRating=known 被服务端正确记录');
    const a4 = await get(`/api/words/${t4.id}`);
    ok(a4.progress.stage >= stage4 + 1,
      '★ stage 有推进（一遍就过跳档）', `${stage4} → ${a4.progress.stage}`);
    ok(done4.data.feedback && done4.data.feedback.delayMinutes > 0,
      '响应里给了下次间隔', `human=${done4.data.feedback && done4.data.feedback.human}`);
  } else {
    ok(true, '队列里没有第 4 个可测的词，跳过');
  }

  /* ---------------- 7. 幂等：重复 pass 不应该重复排期 ---------------- */
  console.log('\n7) 重复 pass 不应重复排期（首答记录已消费）');
  const twice = await post('/api/study/answer', {
    wordId: target.id, rating: 'known', bookCode: BOOK, phase: 'pass', firstRating: 'known',
  });
  ok(twice.status === 409, '★ 第二次 pass 被拒绝（记录已被 takeFirst 消费）',
    `status=${twice.status}`);

  console.log(`\n${'='.repeat(54)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`${'='.repeat(54)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
