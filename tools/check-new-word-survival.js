'use strict';
/*
 * 决定性验证 P0-2：给一个**还没学过**的词写笔记 / 收藏 / 暂缓，
 * 之后它**必须仍然留在「学新词」队列里**。
 *
 * 修复前：这些接口会 INSERT 一行 status='new' 的 progress，
 * 而「学新词」判定是 `p.word_id IS NULL` → 该词永久消失。
 *
 * 这个脚本会**写数据**，只能指向数据库副本！
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3985';
const BOOK = process.argv[3] || 'cet4';

let pass = 0, fail = 0;
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

(async () => {
  console.log(`\n幽灵词修复 · 决定性验证  base=${BASE} book=${BOOK}\n`);

  // 找一个「还没学过」的词：从学新词队列里取第一个
  const plan0 = await get(`/api/study/plan?book=${BOOK}&mode=new`);
  const victim = plan0.queue[0];
  const availBefore = plan0.pools.newAvail;
  const untouchBefore = (await get(`/api/words?book=${BOOK}&status=new&size=1&page=1`)).total;
  const startedBefore = (await get('/api/stats/overview')).started;

  console.log(`目标词: #${victim.id} ${victim.spelling}`);
  console.log(`基线: newAvail=${availBefore}  浏览页未学=${untouchBefore}  已学=${startedBefore}\n`);

  /* ---------- 1. 写笔记 ---------- */
  console.log('1) 给未学的词写笔记');
  const r1 = await post(`/api/words/${victim.id}/note`, { note: '测试助记：不该让这个词消失' });
  ok(r1.status === 200, '写笔记 HTTP 200');

  const plan1 = await get(`/api/study/plan?book=${BOOK}&mode=new`);
  const stillInQueue = plan1.queue.some((x) => x.id === victim.id);
  ok(plan1.pools.newAvail === availBefore,
    '★ newAvail 没有减少（修复前会 -1）', `${availBefore} → ${plan1.pools.newAvail}`);
  const untouchAfter = (await get(`/api/words?book=${BOOK}&status=new&size=1&page=1`)).total;
  ok(untouchAfter === untouchBefore,
    '★ 浏览页「未学」数不变（修复前它会和 newAvail 差 1）',
    `${untouchBefore} → ${untouchAfter}`);
  const startedAfter = (await get('/api/stats/overview')).started;
  ok(startedAfter === startedBefore,
    '★ 「累计学过」没有 +1（修复前幽灵行会被算作已学）',
    `${startedBefore} → ${startedAfter}`);
  ok(stillInQueue, '★ 该词仍在学新词队列里（首批之内）');

  // 而且它还能被查到、带着笔记
  const w = await get(`/api/words/${victim.id}`);
  ok(w.progress && w.progress.note.includes('测试助记'), '笔记确实存下来了');
  ok(w.progress.status === 'new', '它仍被标记为 new');

  /* ---------- 2. 收藏 ---------- */
  console.log('\n2) 再给另一个未学的词加收藏');
  const v2 = plan1.queue.find((x) => x.id !== victim.id);
  const before2 = (await get(`/api/study/plan?book=${BOOK}&mode=new`)).pools.newAvail;
  await post(`/api/words/${v2.id}/favorite`, { favorite: true });
  const after2 = (await get(`/api/study/plan?book=${BOOK}&mode=new`)).pools.newAvail;
  ok(after2 === before2, '★ 收藏也没让 newAvail 减少', `${before2} → ${after2}`);
  const favInQueue = (await get(`/api/study/plan?book=${BOOK}&mode=new`)).queue.some((x) => x.id === v2.id);
  ok(favInQueue, '★ 收藏过的未学词仍在队列里');

  /* ---------- 3. 暂缓 ---------- */
  console.log('\n3) 给未学的词设暂缓');
  const v3 = (await get(`/api/study/plan?book=${BOOK}&mode=new`)).queue
    .find((x) => x.id !== victim.id && x.id !== v2.id);
  const before3 = (await get(`/api/study/plan?book=${BOOK}&mode=new`)).pools.newAvail;
  await post(`/api/words/${v3.id}/suspend`, { suspended: true });
  const after3 = (await get(`/api/study/plan?book=${BOOK}&mode=new`)).pools.newAvail;
  /*
   * 暂缓的语义是「不再进**复习**队列」，它不改变「这个词学没学过」。
   * 但它确实会出现在 status=suspended 筛选里，属于用户主动标记的意图，
   * 所以这里只断言它没有被当成「已学」。
   */
  ok(after3 === before3, '暂缓没让 newAvail 减少（暂缓只影响复习队列）', `${before3} → ${after3}`);
  const started3 = (await get('/api/stats/overview')).started;
  ok(started3 === startedBefore, '暂缓没被算进「累计学过」', `${startedBefore} → ${started3}`);

  /* ---------- 4. 四桶仍然守恒 ---------- */
  console.log('\n4) 四桶守恒（写了一堆标记之后）');
  const st = await get('/api/stats/stages');
  const ov = await get('/api/stats/overview');
  const sum = st.status.new + st.status.learning + st.status.reviewing + st.status.mastered;
  ok(sum === ov.word_total, '四桶之和仍 == word_total', `${sum} vs ${ov.word_total}`);
  ok(ov.started === ov.learning + ov.reviewing + ov.mastered,
    'started 仍 == 三桶之和', `${ov.started} vs ${ov.learning + ov.reviewing + ov.mastered}`);

  /* ---------- 5. 清空笔记后也不是「已学」 ---------- */
  console.log('\n5) 清空笔记后该词仍是「未学」');
  await post(`/api/words/${victim.id}/note`, { note: '' });
  const plan5 = await get(`/api/study/plan?book=${BOOK}&mode=new`);
  ok(plan5.pools.newAvail === availBefore, '清空笔记后 newAvail 依然是原值',
    `${availBefore} → ${plan5.pools.newAvail}`);
  const ov5 = await get('/api/stats/overview');
  ok(ov5.started === startedBefore, '清空笔记后「累计学过」也没变');

  console.log(`\n${'='.repeat(54)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`${'='.repeat(54)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
