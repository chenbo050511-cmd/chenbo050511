'use strict';
/*
 * 助记笔记 + 顽固词（leech）暂缓 的功能验证
 *
 * 用法：node tools/check-notes-suspend.js [baseUrl] [book]
 * 需要一个已在跑的实例（建议 WM_DB 指向数据库副本）：
 *   WM_DB=D:/tmp/copy.db PORT=3992 node server.js --no-open
 *   node tools/check-notes-suspend.js http://127.0.0.1:3992 cet4
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3992';
const BOOK = process.argv[3] || 'cet4';

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  [ok]   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

async function getJson(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

async function postJson(path, body, method = 'POST') {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

/** /api/settings 只接受 PUT，用 POST 会拿到 404（踩过） */
const putJson = (path, body) => postJson(path, body, 'PUT');

async function main() {
  console.log(`\n验证 助记笔记 / 顽固词暂缓  base=${BASE} book=${BOOK}\n`);

  /* ---------------- 助记笔记 ---------------- */
  console.log('1) 助记笔记 存取');
  const list = await getJson(`/api/words?book=${BOOK}&size=3&page=1`);
  const w = list.items[0];
  ok(!!w, '拿到一个词', `id=${w.id} spelling=${w.spelling}`);
  ok(w.has_note === 0, '初始没有笔记（has_note=0）', `has_note=${w.has_note}`);

  const NOTE = '谐音「死逮特」- 死死逮住那个州';
  const saved = await postJson(`/api/words/${w.id}/note`, { note: NOTE });
  ok(saved.status === 200, '保存笔记 HTTP 200');
  ok(saved.data.note === NOTE, '回传的笔记内容一致');
  ok(saved.data.saved === true, 'saved=true');

  const detail = await getJson(`/api/words/${w.id}`);
  ok(detail.progress && detail.progress.note === NOTE, '详情接口能读到笔记');
  ok(detail.maxStage === 5, '详情带上了 maxStage（不再是写死的 /9）', `maxStage=${detail.maxStage}`);

  const list2 = await getJson(`/api/words?book=${BOOK}&size=3&page=1`);
  const w2 = list2.items.find((x) => x.id === w.id);
  ok(w2 && w2.has_note === 1, '列表里出现「有笔记」标记（has_note=1）');

  // 长度上限
  const long = 'x'.repeat(900);
  const capped = await postJson(`/api/words/${w.id}/note`, { note: long });
  ok(capped.data.note.length === 500, '笔记超长被截到 500', `len=${capped.data.note.length}`);

  // 类型校验
  const badType = await postJson(`/api/words/${w.id}/note`, { note: 12345 });
  ok(badType.status === 400, '非字符串笔记被拒（HTTP 400）', `status=${badType.status}`);

  // 清除
  const cleared = await postJson(`/api/words/${w.id}/note`, { note: '' });
  ok(cleared.data.saved === false && cleared.data.note === '', '传空字符串即清除笔记');
  const detail2 = await getJson(`/api/words/${w.id}`);
  ok(detail2.progress && detail2.progress.note === '', '详情里笔记已清空');

  // 不存在的词
  const nf = await postJson('/api/words/99999999/note', { note: 'x' });
  ok(nf.status === 404, '不存在的词返回 404', `status=${nf.status}`);

  /* ---------------- 顽固词暂缓 ---------------- */
  console.log('\n2) 顽固词：暂缓后不再进复习队列');

  const plan0 = await getJson(`/api/study/plan?book=${BOOK}&mode=review`);
  const dueBefore = plan0.dueNow;
  ok(dueBefore > 0, '复习队列里本来有到期的词', `dueNow=${dueBefore}`);

  const target = plan0.queue[0];
  ok(!!target, '取出队列里的第一个词', `id=${target.id} ${target.spelling}`);

  const sus = await postJson(`/api/words/${target.id}/suspend`, { suspended: true });
  ok(sus.status === 200 && sus.data.suspended === 1, '暂缓成功', JSON.stringify(sus.data));

  const plan1 = await getJson(`/api/study/plan?book=${BOOK}&mode=review`);
  ok(plan1.dueNow === dueBefore - 1, '复习队列少了一个词', `dueNow ${dueBefore} -> ${plan1.dueNow}`);
  ok(!plan1.queue.some((x) => x.id === target.id), '被暂缓的词不在队列里');
  ok(plan1.suspendedCount >= 1, '接口报告了「已暂缓」数量', `suspendedCount=${plan1.suspendedCount}`);
  ok(plan1.suspended.some((x) => x.id === target.id), '已暂缓列表里能找到它');

  // 徽标一致性：/api/books 的 due 也要排除暂缓词
  const books = await getJson('/api/books');
  const bk = books.find((b) => b.code === BOOK);
  const dueList = await getJson(`/api/words?book=${BOOK}&status=due&size=1&page=1`);
  ok(bk.due === dueList.total, '侧边栏徽标(books.due) 与「待复习」筛选结果一致',
    `books.due=${bk.due} 列表=${dueList.total}`);
  ok(bk.due === dueBefore - 1, '徽标里的 due 也排除了暂缓词', `due=${bk.due} 原=${dueBefore}`);

  // started 不应该被排除（暂缓只是不复习，不代表没学过）
  ok(bk.started > 0, 'started 仍然统计已学（未被暂缓影响）', `started=${bk.started}`);

  // 状态筛选
  const susList = await getJson(`/api/words?book=${BOOK}&status=suspended&size=10&page=1`);
  ok(susList.items.some((x) => x.id === target.id), '可用 status=suspended 筛出顽固词');
  ok(susList.items.every((x) => x.suspended === 1), '筛选结果全部是已暂缓');

  // 恢复
  const unsus = await postJson(`/api/words/${target.id}/suspend`, { suspended: false });
  ok(unsus.data.suspended === 0, '恢复复习成功');
  const plan2 = await getJson(`/api/study/plan?book=${BOOK}&mode=review`);
  ok(plan2.dueNow === dueBefore, '恢复后队列数量回到原值', `dueNow=${plan2.dueNow}`);
  ok(plan2.queue.some((x) => x.id === target.id), '恢复后该词重新出现在队列里');

  /* ---------------- 顽固词判定（leech） ---------------- */
  console.log('\n3) 顽固词清单判定');
  /*
   * 不依赖数据库里「碰巧」已经有顽固词 —— 自己造。
   *
   * 做法：交两组**全部答错**的测试（每组 15 题）。词库抽词是随机的，
   * 两组之间必有重叠的词，那些词 quiz_wrong 就到 2，越过阈值 2。
   *
   * ⚠️ 注意必须用**这一组题自己的 wordId**。以前这里为了图省事，
   * 拿一个有效 session 去报另一个词的 wordId（想精确控制是哪个词变顽固），
   * 那正好是「后门改任意词排期」这个漏洞的写法 —— 后端现在会拒绝它
   * （skip 掉、不写库，见 verify-quiz-grading.js 第 8 节）。
   */
  await putJson('/api/settings', { leech_threshold: '2' });

  /*
   * 抽词是随机的，所以「两组各 15 题必有重叠」这个假设是错的
   * （3518 词的词库里，15 对 15 的期望重叠只有 0.06 个）。
   * 改成多轮、每组 50 题，直到出现重叠为止 —— 比死磕一个概率假设稳。
   */
  const seen = new Map();          // wordId -> 已经答错几次
  let rounds = 0;
  while (rounds < 6 && ![...seen.values()].some((n) => n >= 2)) {
    rounds++;
    const quiz = await getJson(`/api/quiz?book=${BOOK}&count=50&type=en2cn`);
    const answers = quiz.questions.map((q, i) => ({
      index: i,
      wordId: q.wordId,               // 必须用这一组题自己的词
      chosen: 'DEFINITELY-WRONG',     // 不可能匹配，保证判错
    }));
    const res = await postJson('/api/quiz/submit', {
      bookCode: BOOK, sessionId: quiz.sessionId, answers,
    });
    ok(res.status === 200 && res.data.skipped === 0,
      `第 ${rounds} 组全部答错已受理（skipped=0）`,
      `status=${res.status} skipped=${res.data && res.data.skipped}`);
    for (const q of quiz.questions) seen.set(q.wordId, (seen.get(q.wordId) || 0) + 1);
  }

  const twice = [...seen.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
  ok(twice.length > 0,
    `有词被答错 ≥2 次（它们会变成顽固词）`,
    `${rounds} 轮后共 ${twice.length} 个`);

  const l = await getJson(`/api/quiz/leeches?book=${BOOK}&limit=200`);
  ok(l.threshold === 2, '阈值来自设置', `threshold=${l.threshold}`);
  ok(l.total > 0, '阈值 2 能筛出顽固词', `total=${l.total}`);
  ok(l.items.every((x) => x.lapses >= 2), '命中的词 lapses 都 >= 阈值',
    `min=${l.items.length ? Math.min(...l.items.map((x) => x.lapses)) : '-'}`);
  const laps = l.items.map((x) => x.lapses);
  ok(JSON.stringify(laps) === JSON.stringify([...laps].sort((a, b) => b - a)),
    '按 lapses 递减排序', `lapses=${laps.slice(0, 8).join(',')}${laps.length > 8 ? '…' : ''}`);
  ok(l.items.every((x) => typeof x.note === 'string' && typeof x.suspended === 'number'),
    '每项都带 note / suspended 字段');
  ok(l.items.some((x) => twice.includes(x.id)),
    '答错两次以上的词确实出现在顽固词清单里',
    `应出现 ${twice.length} 个，命中 ${l.items.filter((x) => twice.includes(x.id)).length} 个`);

  /*
   * 这一条是回归：`joinBook` 里的 `?` 出现在 WHERE 之前，
   * 参数顺序弄反时接口不报错、只静默返回空 —— 曾经 book=cet4 永远 0 条。
   */
  const lNoBook = await getJson('/api/quiz/leeches?limit=100');
  ok(lNoBook.total >= l.total, '带 book 过滤的结果不应多于不带过滤',
    `book=${l.total} 全部=${lNoBook.total}`);
  ok(l.total > 0 && lNoBook.total > 0, '带 book 过滤不是空结果（参数顺序回归）',
    `book=${l.total}`);

  // 阈值调高 -> 结果变少
  const setHigh = await putJson('/api/settings', { leech_threshold: '1000' });
  ok(setHigh.data && setHigh.data.settings && setHigh.data.settings.leech_threshold === '1000',
    '阈值已写入设置',
    `stored=${JSON.stringify(setHigh.data && setHigh.data.settings && setHigh.data.settings.leech_threshold)}`);
  const lHigh = await getJson(`/api/quiz/leeches?book=${BOOK}&limit=100`);
  ok(lHigh.threshold === 1000, '接口读到的阈值也是 1000', `threshold=${lHigh.threshold}`);
  ok(lHigh.total === 0, '阈值 1000 时没有顽固词', `total=${lHigh.total}`);
  await putJson('/api/settings', { leech_threshold: '6' });   // 还原默认

  /* ---------------- 错题本字段 ---------------- */
  console.log('\n4) 错题本字段完整性');
  const mk = await getJson(`/api/quiz/mistakes?book=${BOOK}&limit=50`);
  if (mk.items.length) {
    ok(mk.items.every((x) => 'suspended' in x && 'note' in x),
      '错题本条目带 suspended / note');
  } else {
    ok(true, '错题本为空，跳过字段检查');
  }

  /* ---------------- 今天页的统计 ---------------- */
  console.log('\n5) 今天页统计');
  /*
   * ⚠️ 这两个数必须**同一时刻**取。
   * 之前拿的是上面复习测试里的 plan2 快照，中间又跑了一堆会改 due_at 的
   * 测验作答（答错的词会被排到明天 → 明天不再是「已到期」），
   * 于是出现 today=105 / plan=106 的假失败 —— 是测试自己的竞态，不是接口的错。
   */
  const [today, planNow] = await Promise.all([
    getJson(`/api/study/today?book=${BOOK}`),
    getJson(`/api/study/plan?book=${BOOK}&mode=review`),
  ]);
  ok(today.global && typeof today.global.suspendedWords === 'number',
    'today 暴露了 suspendedWords', `suspendedWords=${today.global.suspendedWords}`);
  ok(today.pools.dueTotal === planNow.dueNow, 'today.pools.dueTotal 与队列一致（同时刻取值）',
    `today=${today.pools.dueTotal} plan=${planNow.dueNow}`);

  console.log(`\n${'='.repeat(52)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`${'='.repeat(52)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n验证脚本出错：', err.message);
  console.error('（确认服务已在 ' + BASE + ' 运行，且 WM_DB 指向数据库副本）\n');
  process.exit(2);
});
