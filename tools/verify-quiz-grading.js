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

  /* ---------------- 3. 拿别组的 wordId 凑数也要判错 ---------------- */
  console.log('\n3) 用不属于本组的 wordId 提交要判错');
  const other = await getJson(`/api/quiz?book=${BOOK}&count=5&type=en2cn`);
  const mismatched = await postJson('/api/quiz/submit', {
    bookCode: BOOK,
    sessionId: other.sessionId,
    // index=0 但 wordId 用另一组的题 → 下标与 wordId 对不上
    answers: [{ index: 0, wordId: target.wordId, chosen: other.questions[0].options[0].key }],
  });
  ok(mismatched.data.results[0].correct === false, '下标与 wordId 不匹配 → 判错');

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

  /* ---------------- 7. 老页面（无 sessionId）仍可提交 ---------------- */
  console.log('\n7) 兼容性：无 sessionId 的老页面仍能提交');
  const legacy = await postJson('/api/quiz/submit', {
    bookCode: BOOK,
    answers: [{ wordId: target.wordId, correct: false }],
  });
  ok(legacy.status === 200, '老页面提交被接受', `status=${legacy.status}`);
  ok(legacy.data.graded === 'legacy', '标记为 legacy', `graded=${legacy.data.graded}`);
  ok(legacy.data.results[0].correct === false, 'legacy 分支按传入的 correct 处理');

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
