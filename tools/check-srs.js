'use strict';
/*
 * 排期算法回归（src/srs.js）—— 纯函数测试，不需要起服务。
 *
 * srs.js 是整个应用里唯一「算错了也不报错、只会静默按错的间隔排期」的地方，
 * 所以它最需要有测试兜着。这个文件**不依赖数据库、不依赖网络**。
 *
 * 用法：node tools/check-srs.js
 */

const srs = require('../src/srs');

const DAY = 24 * 60;
let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  [ok]   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? '  ' + extra : ''}`); }
}

/** 造一个「已经学到某档」的进度对象 */
const at = (stage, reps = 5) => ({ status: stage < 0 ? 'new' : 'learning', stage: Math.max(stage, 0), reps });
/** 只比较到「天」的粗粒度（fuzz 会让分钟数抖动） */
const days = (m) => m / DAY;

console.log('\n排期算法回归（srs.js）\n');

/* ---------------- 1. 新词的起点 ---------------- */
console.log('1) 新词的起点');
{
  const k = srs.schedule({ status: 'new', reps: 0 }, 'known');
  ok(k.stage === 1, '新词「认识」→ stage 1（跳 2 档，起点按 -1 算）', `stage=${k.stage}`);
  ok(Math.abs(days(k.delayMinutes) - 3) <= 3 * 0.15 + 1e-9,
    '间隔 ≈ 3 天（3 天落在抖动带里，允许 ±15%）', `${days(k.delayMinutes).toFixed(2)} 天`);

  const u = srs.schedule({ status: 'new', reps: 0 }, 'unknown');
  ok(u.stage === 0, '新词「不认识」→ stage 0', `stage=${u.stage}`);
  ok(days(u.delayMinutes) === 1, '间隔 = 1 天（明天，短间隔不抖动）', `${days(u.delayMinutes)} 天`);

  const v = srs.schedule({ status: 'new', reps: 0 }, 'vague');
  ok(v.stage === 0, '新词「模糊」→ stage 0（起点 -1 + 1 档）', `stage=${v.stage}`);
  ok(days(v.delayMinutes) === 1, '间隔 = 1 天（和「不认识」一样是明天）');
}

/* ---------------- 2. 三档反馈的档位 ---------------- */
console.log('\n2) 三档反馈各自跳几档');
{
  // 认识 +2、模糊 +1、不认识 回 0
  const expect = [
    // stage, known, vague, unknown
    [0, 2, 1, 0],
    [1, 3, 2, 0],
    [2, 4, 3, 0],
    [3, 5, 4, 0],
    [4, 5, 5, 0],   // 认识封顶
    [5, 5, 5, 0],
  ];
  for (const [st, k, v, u] of expect) {
    const rk = srs.schedule(at(st), 'known');
    const rv = srs.schedule(at(st), 'vague');
    const ru = srs.schedule(at(st), 'unknown');
    ok(rk.stage === k && rv.stage === v && ru.stage === u,
      `stage ${st} → 认识 ${rk.stage} / 模糊 ${rv.stage} / 不认识 ${ru.stage}`,
      `期望 ${k}/${v}/${u}`);
  }
}

/* ---------------- 3. 模糊必须区别于认识、也不能等同于「原地踏步」 ---------------- */
console.log('\n3) 「模糊」是一个真正有区别的档位');
{
  /*
   * 只有一处会与「不认识」重合：**新词**（起点 -1）+1 档 = 0 档，
   * 而不认识也是 0 档 —— 这是设计上成立的（新词答模糊和不认识都是明天再来，
   * 区别在 vague_count 与之后的起点）。除此之外任何 stage 都不该重合。
   */
  let sameAsUnknown = 0;
  for (let st = 0; st <= srs.MAX_STAGE; st++) {
    const v = srs.schedule(at(st), 'vague');
    const u = srs.schedule(at(st), 'unknown');
    if (v.stage === u.stage) sameAsUnknown++;
  }
  ok(sameAsUnknown === 0, '已学过的词：模糊的档位从不等于「不认识」',
    `相同 ${sameAsUnknown} 次`);

  const newVague = srs.schedule({ status: 'new', reps: 0 }, 'vague');
  const newUnknown = srs.schedule({ status: 'new', reps: 0 }, 'unknown');
  ok(newVague.stage === newUnknown.stage,
    '新词的模糊与不认识落在同一档（都是明天）—— 这一处重合是有意的');

  // 对已学过的词，模糊必须比不认识走得更远
  let notFurther = 0;
  for (let st = 1; st <= srs.MAX_STAGE; st++) {
    if (srs.schedule(at(st), 'vague').stage <= srs.schedule(at(st), 'unknown').stage) notFurther++;
  }
  ok(notFurther === 0, '已学过的词：模糊推得比不认识更远（修复前两者完全相同）',
    `未推远 ${notFurther} 次`);
}

/* ---------------- 4. 阶段与间隔表对得上 ---------------- */
console.log('\n4) 阶段号与间隔表一致');
{
  for (let st = 0; st <= srs.MAX_STAGE; st++) {
    // 用「不认识」以外的方式落到每一档不容易，直接核对表本身
    ok(srs.INTERVALS[st] === [1, 3, 7, 15, 30, 60][st] * DAY,
      `stage ${st} 的间隔 = ${[1, 3, 7, 15, 30, 60][st]} 天`, `${days(srs.INTERVALS[st])} 天`);
  }
}

/* ---------------- 5. fuzz：留在允许带内 ---------------- */
console.log('\n5) fuzz 落在允许的抖动带内');
{
  /*
   * 参数来自 Anki（fuzz.rs）：<2.5 天不抖；(2.5,7] ±15%；(7,20] ±10%；(20,∞) ±5%
   *
   * 注意基准是**最终落到的档位**：从 `stage-2` 出发答「known」跳 2 档，
   * 正好落到我们想测的那一档。上一轮的间隔必须比它短，否则「不许倒退」
   * 那条会把下界抬起来 —— 所以按 stage-1 的间隔当「上次」。
   *
   * 上界也要留意：若「上次」比抖动上界还长，实际间隔会被抬到「上次」，
   * 这是保护规则的正常行为，所以额外断言「上界 < 上次间隔」时才卡上界。
   */
  const cases = [
    // 出发档, 落到的档, 该档天数, 抖动系数
    { from: 0, to: 2, base: 7, factor: 0.15 },
    { from: 1, to: 3, base: 15, factor: 0.1 },
    { from: 2, to: 4, base: 30, factor: 0.1 },
    { from: 3, to: 5, base: 60, factor: 0.05 },
  ];
  for (const c of cases) {
    const limit = c.base * (1 + c.factor);
    let over = 0;
    let under = 0;
    const distinct = new Set();
    for (let i = 0; i < 300; i++) {
      const d = days(srs.schedule(at(c.from), 'known').delayMinutes);
      distinct.add(d.toFixed(3));
      if (d > limit + 1e-9) over++;
      /*
       * 下界 = **上一次的间隔**（不是基准）。
       * 「不许倒退」的语义是：抖动不能把间隔压到上一轮之下。
       * 上一次是 from+... 那一档，间隔比目标档短，所以下界通常就是它。
       */
      const prevDays = days(srs.INTERVALS[Math.max(0, c.from)]);
      if (d < Math.min(prevDays, c.base) - 1e-9) under++;
    }
    ok(over === 0, `${c.base} 天档：不超过抖动上界 ${limit.toFixed(1)} 天`, `越界 ${over} 次`);
    ok(under === 0, `${c.base} 天档：不小于上一次的间隔（不许倒退）`,
      `低于下界 ${under} 次`);
    ok(distinct.size > 20, `${c.base} 天档：确实在抖动（不是固定值）`,
      `300 次采样里 ${distinct.size} 个不同值`);
  }

  /*
   * 「不许倒退」的语义：抖动不能把间隔压到**上一次的间隔**之下。
   * 上面的循环里「上次」是出发档的间隔，这里直接针对最容易踩的那条：
   * 上次 3 天（stage 1），这次答「模糊」落到 stage 2 = 7 天 ——
   * 7 天往下抖 15% 是 5.95 天，仍然 > 3 天，所以下界由 3 天守住，不会倒退。
   */
  {
    let below = 0;
    let minSeen = Infinity;
    for (let i = 0; i < 500; i++) {
      const p = { status: 'learning', stage: 1, reps: 3, last_rating: 'known' };
      const d = days(srs.schedule(p, 'vague').delayMinutes);   // stage 1 +1 → stage 2（7 天）
      minSeen = Math.min(minSeen, d);
      if (d < 3 - 1e-9) below++;
    }
    ok(below === 0, '上次 3 天、这次 7 天：抖动后仍 ≥ 3 天（不许倒退）',
      `低于 3 天 ${below} 次，最小 ${minSeen.toFixed(2)} 天`);
  }

  /*
   * lapse（答「不认识」）之后必须允许真正缩短 ——
   * 那是有意的惩罚，不能被「不许倒退」吃掉。
   */
  {
    const p = { status: 'reviewing', stage: 4, reps: 6, last_rating: 'unknown' };
    const d = days(srs.schedule(p, 'vague').delayMinutes);   // stage 4 +1 → stage 5
    ok(d > 30, 'lapse 之后答「模糊」仍会推进（不受 lapse 影响）', `${d.toFixed(2)} 天`);

    const u = days(srs.schedule(p, 'unknown').delayMinutes);
    ok(u === 1, 'lapse 之后答「不认识」就是 1 天（惩罚没被 fuzz 或下界改掉）', `${u} 天`);
  }
}

/* ---------------- 6. 短间隔不该抖动 ---------------- */
console.log('\n6) 「明天再来」不抖动');
{
  let varied = 0;
  const first = days(srs.schedule(at(0), 'unknown').delayMinutes);
  for (let i = 0; i < 100; i++) {
    if (days(srs.schedule(at(0), 'unknown').delayMinutes) !== first) varied++;
  }
  ok(varied === 0, '「不认识」的 1 天间隔始终是 1 天（惩罚不该被随机化）',
    `出现 ${varied} 次不同值`);
}

/* ---------------- 7. fuzzInterval 的边界 ---------------- */
console.log('\n7) fuzzInterval 直接测试');
{
  ok(srs.fuzzInterval(1 * DAY) === 1 * DAY, '1 天（<2.5 天）不加抖动');
  ok(srs.fuzzInterval(2 * DAY) === 2 * DAY, '2 天（<2.5 天）不加抖动');
  {
    const v = srs.fuzzInterval(3 * DAY);
    ok(Math.abs(v - 3 * DAY) <= 3 * DAY * 0.15 + 1,
      '3 天加了抖动且在 ±15% 之内', `${(v / DAY).toFixed(2)} 天`);
  }

  // 「不许倒退」：算出的间隔 > 上次间隔时，抖动不能把它压到上次以下
  let worse = 0;
  for (let i = 0; i < 500; i++) {
    const out = srs.fuzzInterval(7 * DAY, 6 * DAY);
    if (out < 6 * DAY) worse++;
  }
  ok(worse === 0, '上次 6 天、这次算 7 天 → 抖动后仍 >= 6 天（不许倒退）',
    `低于上次 ${worse} 次`);

  // 上次更长时不该被这条规则硬拉长
  const shrink = srs.fuzzInterval(1 * DAY, 30 * DAY);
  ok(shrink === 1 * DAY, 'lapse 回 1 天时不会被「不许倒退」硬拉长', `${days(shrink)} 天`);
}

/* ---------------- 8. 非法输入 ---------------- */
console.log('\n8) 非法反馈值要报错，不能静默');
{
  let threw = false;
  try { srs.schedule(at(1), 'nonsense'); } catch { threw = true; }
  ok(threw, '未知 rating 抛错（避免静默按某个默认值排期）');
}

/* ---------------- 9. reps 与 status ---------------- */
console.log('\n9) reps 递增与 status 推导');
{
  const r = srs.schedule(at(1, 4), 'known');
  ok(r.reps === 5, 'reps +1（它表示「过关轮次」）', `reps=${r.reps}`);
  ok(srs.statusOf(0, 1) === 'learning', 'stage 0 + 有 reps → learning');
  ok(srs.statusOf(2, 3) === 'reviewing', 'stage 2 → reviewing');
  ok(srs.statusOf(4, 3) === 'mastered', 'stage 4 → mastered');
  ok(srs.statusOf(3, 0) === 'new', 'reps=0 → new（还没学过）');
}

/* ---------------- 10. 阶段标签与间隔表同源 ---------------- */
console.log('\n10) 阶段标签由间隔表推导');
{
  const labels = srs.stageLabels();
  ok(labels.length === srs.MAX_STAGE + 1, '标签数 = MAX_STAGE+1', `${labels.length}`);
  ok(labels[0] === '1 天' && labels[5] === '60 天', '首尾标签正确',
    `${labels[0]} … ${labels[5]}`);
  ok(labels.every((l) => l && l.trim() === l), '标签没有首尾空白（曾经首个标签混进过 BOM）',
    JSON.stringify(labels.slice(0, 2)));
}

console.log(`\n${'='.repeat(54)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`${'='.repeat(54)}\n`);
process.exit(fail ? 1 : 0);
