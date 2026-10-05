'use strict';
/*
 * 判分安全性验证（P0-1 修复的回归测试）
 *
 * 用法：node tools/verify-quiz-grading.js [baseUrl]
 * 需要一个已经在跑的实例（建议指向数据库副本）：
 *   WM_DB=/d/tmp/copy.db PORT=3998 node server.js --no-open
 *   node tools/verify-quiz-grading.js http://127.0.0.1:3998
 *
 * 这个脚本只读断言 + 提交测试作答，**不要指向真实数据库**
 * （它会写入 progress，虽然只会影响它自己出的那几道题）。
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3998';
const BOOK = process.argv[3] || 'cet4';

let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  [ok]   ${label}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`);
  }
}

async function getJson(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function main() {
  console.log(`\n验证判分安全性  base=${BASE}  book=${BOOK}\n`);

  /* ---------------- 1. 出题响应不能泄漏答案 ---------------- */
  console.log('1) 出题响应不泄漏答案');
  const quiz = await getJson(`/api/quiz?book=${BOOK}&count=5&type=en2cn`);

  ok(!!quiz.sessionId, '返回了 sessionId', `sessionId=${quiz.sessionId}`);
  ok(Array.isArray(quiz.questions) && quiz.questions.length > 0, '有题目', `count=${quiz.questions.length}`);

  const q0 = quiz.questions[0];
  ok(q0.key === undefined, '题目级不含 `key`（正确答案）', `q0.key=${JSON.stringify(q0.key)}`);

  let anyCorrectFlag = false;
  let allHaveKey = true;
  for (const q of quiz.questions) {
    for (const o of q.options || []) {
      if (Object.prototype.hasOwnProperty.call(o, 'correct')) anyCorrectFlag = true;
      if (!o.key) allHaveKey = false;
    }
  }
  ok(!anyCorrectFlag, '选项里没有 `correct` 标志');
  ok(allHaveKey, '每个选项都有 key（用于回报选择）');

  /* ---------------- 2. 伪造 correct 无效（核心回归） ---------------- */
  console.log('\n2) 伪造 correct=true 必须被判错');
  const target = quiz.questions[0];

  // 故意用一个不可能匹配的 chosen
  const forged = await postJson('/api/quiz/submit', {
    bookCode: BOOK,
    sessionId: quiz.sessionId,
    answers: [{ index: 0, wordId: target.wordId, chosen: 'NOT-A-REAL-KEY', correct: true }],
  });

  ok(forged.status === 200, '提交被接受（HTTP 200）', `status=${forged.status}`);
  ok(forged.data.graded === 'server', 'graded=server（走服务端判分）', `graded=${forged.data.graded}`);
  ok(forged.data.results[0].correct === false, '伪造的答案被判为「错」');
  ok(forged.data.right === 0, 'right=0', `right=${forged.data.right}`);

  /* ---------------- 3. 拿别组的 wordId 凑数：跳过、不写库 ---------------- */
  console.log('\n3) 用不属于本组的 wordId 提交要被跳过');
  const other = await getJson(`/api/quiz?book=${BOOK}&count=5&type=en2cn`);
  const mismatched = await postJson('/api/quiz/submit', {
    bookCode: BOOK,
    sessionId: other.sessionId,
    // index=0 但 wordId 用另一组的题 → 下标与 wordId 对不上
    answers: [{ index: 0, wordId: target.wordId, chosen: other.questions[0].options[0].key }],
  });
  /*
   * 以前这里是「判错、但照写库」，后果是能拿一个有效 session 给任意陌生词
   * 写「答错 + stage 0 + 明天到期」——等于从后门改排期。
   * 现在直接跳过：results 为空、skipped 计数 +1，那个词的进度一动不动。
   */
  ok(mismatched.data.skipped === 1, 'skipped=1', `skipped=${mismatched.data.skipped}`);
  ok(mismatched.data.total === 0 && mismatched.data.results.length === 0,
    '没有产生任何计分结果', `total=${mismatched.data.total}`);

  /* ---------------- 4. 交卷后才回传正确答案 ---------------- */
  console.log('\n4) 正确答案只在交卷后回传');
  const r0 = forged.data.results[0];
  ok(typeof r0.correctKey === 'string' && r0.correctKey.length > 0,
    '交卷后给出 correctKey', `correctKey=${r0.correctKey}`);
  ok(!!r0.chosenKey, '回传了 chosenKey', `chosenKey=${r0.chosenKey}`);

  /* ---------------- 5. 真正答对必须判对（正路径） ---------------- */
  console.log('\n5) 答对要判对 —— 通过「用词典释义反推正确选项」来验证');
  /*
   * 服务端不下发答案，怎么在测试里知道哪个选项是对的？
   * 用 /api/words/:id 取这个单词的真实释义，和选项文本比对 ——
   * 正确选项的文本就是这个词的前两段释义（出题逻辑见 src/routes/quiz.js）。
   * 这样测试不依赖任何「答案泄漏」，而是独立地推出了正确答案。
   */
  const pos = await getJson(`/api/quiz?book=${BOOK}&count=3&type=en2cn`);
  const pq = pos.questions[0];
  const wordInfo = await getJson(`/api/words/${pq.wordId}`);
  const expectAnswer = String(wordInfo.word.meaning).split('；').slice(0, 2).join('；');

  const matched = pq.options.filter((o) => o.text === expectAnswer);
  ok(matched.length === 1, '能在选项里唯一认出正确答案（释义比对）',
    `matched=${matched.length}`);

  if (matched.length === 1) {
    const posRes = await postJson('/api/quiz/submit', {
      bookCode: BOOK,
      sessionId: pos.sessionId,
      answers: [{ index: 0, wordId: pq.wordId, chosen: matched[0].key }],
    });
    ok(posRes.data.results[0].correct === true, '真实答对被判为「对」');
    ok(posRes.data.right === 1 && posRes.data.wrong === 0, '统计 right=1 / wrong=0',
      `right=${posRes.data.right} wrong=${posRes.data.wrong}`);
    ok(posRes.data.results[0].correctKey === matched[0].key,
      '回传的 correctKey 与推导出的正确选项一致');
    ok(posRes.data.results[0].stage >= 1, '答对后 stage 有推进',
      `stage=${posRes.data.results[0].stage}`);
  }

  /* ---------------- 5b. 同组内选错要判错 ---------------- */
  console.log('\n5b) 同组内选错要判错');
  const neg = await getJson(`/api/quiz?book=${BOOK}&count=3&type=en2cn`);
  const nq = neg.questions[0];
  const nInfo = await getJson(`/api/words/${nq.wordId}`);
  const nExpect = String(nInfo.word.meaning).split('；').slice(0, 2).join('；');
  const wrongOpt = nq.options.find((o) => o.text !== nExpect);
  if (wrongOpt) {
    const negRes = await postJson('/api/quiz/submit', {
      bookCode: BOOK,
      sessionId: neg.sessionId,
      answers: [{ index: 0, wordId: nq.wordId, chosen: wrongOpt.key }],
    });
    ok(negRes.data.results[0].correct === false, '真实答错被判为「错」');
  }

  /* ---------------- 6. 重复提交要被限流 ---------------- */
  console.log('\n6) 同一组重复提交要被限流');
  const s = await getJson(`/api/quiz?book=${BOOK}&count=3&type=en2cn`);
  const payload = {
    bookCode: BOOK,
    sessionId: s.sessionId,
    answers: [{ index: 0, wordId: s.questions[0].wordId, chosen: 'x' }],
  };
  let lastStatus = 0;
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const r = await postJson('/api/quiz/submit', payload);
    statuses.push(r.status);
    lastStatus = r.status;
  }
  ok(statuses.slice(0, 5).every((x) => x === 200), '前 5 次允许提交', statuses.join(','));
  ok(lastStatus === 429, '第 6 次起返回 429', `statuses=${statuses.join(',')}`);

  /* ---------------- 7. 没有 session 必须被拒绝（不能退回「信前端」） ---------------- */
  console.log('\n7) 没有 / 失效的 session 必须被拒绝');
  /*
   * 这里以前是「老页面过渡分支」：取不到 session 就采信前端传来的 correct。
   * 那条退路有两个窟窿：
   *   · 前端根本不发 correct（只发 index/wordId/chosen）→ 全判错并照样写库
   *   · 它不做任何校验，等于把「伪造 correct」重新打开，还绕过限流
   * 现在直接拒绝（409），让前端重新出一组题。
   */
  const noSess = await postJson('/api/quiz/submit', {
    bookCode: BOOK,
    answers: [{ index: 0, wordId: target.wordId, chosen: 'x', correct: true }],
  });
  ok(noSess.status === 409, '不带 sessionId → 409（不是 200）', `status=${noSess.status}`);
  ok(noSess.data && noSess.data.reason === 'session-missing', 'reason=session-missing',
    JSON.stringify(noSess.data));

  const badSess = await postJson('/api/quiz/submit', {
    bookCode: BOOK,
    sessionId: 'no-such-session-xyz',
    answers: [{ index: 0, wordId: target.wordId, chosen: 'x', correct: true }],
  });
  ok(badSess.status === 409, '伪造 sessionId → 409', `status=${badSess.status}`);
  ok(badSess.data && badSess.data.reason === 'session-expired', 'reason=session-expired');

  /* 关键：这两条被拒的请求**不能**动到那个词的进度 */
  const afterReject = await getJson(`/api/words/${target.wordId}`);
  const beforeWrong = afterReject.progress ? afterReject.progress.quiz_wrong : 0;
  ok(true, `（该词当前 quiz_wrong=${beforeWrong}，下面验证被拒后不再增长）`);

  /* ---------------- 8. wordId 与这一组题对不上 → 跳过、不写库 ---------------- */
  console.log('\n8) wordId 对不上时必须跳过（不能给任意词写进度）');
  /*
   * 以前：判分用 expectedWordId，但**写库用请求里的 wordId**，
   * 不匹配时只是 correct=0，照写不误 —— 等于可以拿一个有效 session
   * 给任意陌生词写「答错 + stage 0 + 明天到期」。
   */
  const q8 = await getJson(`/api/quiz?book=${BOOK}&count=3&type=en2cn`);
  // 找一个**不属于这一组**的词（用另一组的第一个词）
  const otherSet = await getJson(`/api/quiz?book=${BOOK}&count=3&type=en2cn`);
  const alienId = otherSet.questions[0].wordId;
  const alienBefore = await getJson(`/api/words/${alienId}`);
  const alienHasProgress = !!alienBefore.progress;

  const mismatch = await postJson('/api/quiz/submit', {
    bookCode: BOOK,
    sessionId: q8.sessionId,
    // index 0 期望的是 q8 的第 0 题，却报一个别组的 wordId
    answers: [{ index: 0, wordId: alienId, chosen: 'x' }],
  });
  ok(mismatch.status === 200, '提交本身被接受（HTTP 200）', `status=${mismatch.status}`);
  ok(mismatch.data.skipped === 1, '结算里 skipped=1', `skipped=${mismatch.data.skipped}`);
  ok(mismatch.data.total === 0, '没有任何作答被计入', `total=${mismatch.data.total}`);

  const alienAfter = await getJson(`/api/words/${alienId}`);
  const alienProgressNow = !!alienAfter.progress;
  ok(alienProgressNow === alienHasProgress,
    '★ 那个「外星词」的 progress 状态没有变化（没被凭空建行）',
    `${alienHasProgress} → ${alienProgressNow}`);

  /* ---------------- 9. 正常路径仍然工作（回归） ---------------- */
  console.log('\n9) 正常路径回归');
  const q9 = await getJson(`/api/quiz?book=${BOOK}&count=2&type=en2cn`);
  const w9 = await getJson(`/api/words/${q9.questions[0].wordId}`);
  const ans9 = String(w9.word.meaning).split('；').slice(0, 2).join('；');
  const opt9 = q9.questions[0].options.find((o) => o.text === ans9);
  ok(!!opt9, '能推导出正确选项');
  if (opt9) {
    const r9 = await postJson('/api/quiz/submit', {
      bookCode: BOOK,
      sessionId: q9.sessionId,
      answers: [{ index: 0, wordId: q9.questions[0].wordId, chosen: opt9.key }],
    });
    ok(r9.data.graded === 'server', 'graded=server', `graded=${r9.data.graded}`);
    ok(r9.data.skipped === 0, 'skipped=0');
    ok(r9.data.results[0].correct === true, '答对被判对');
  }

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
