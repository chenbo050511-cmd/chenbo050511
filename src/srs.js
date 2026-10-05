'use strict';

/**
 * 复习排期。
 *
 * 规则是「日粒度 + 两档分化」：
 *   · 认识       → 一遍就过，下次往前跳 2 档（已经会的词不浪费时间）
 *   · 模糊       → 也算过关，但只往前 **1** 档（学到了，但没完全想起来）
 *   · 不认识     → 回到第 0 档，也就是**明天**再来
 *
 * 刻意**不用同一日内的短间隔**（以前有 5 分钟 / 30 分钟 / 12 小时三档）。
 * 那种设计会让当天反复到期：用户明明做完了，侧边栏徽标又涨回几十上百，
 * 看起来就像「没做完」。间隔一旦落在「天」上，就不会有这种自相矛盾。
 * （这一条与 Anki 官方在 FSRS 文档里的建议一致：同日多次重复对长期记忆
 *   贡献不显著，官方建议把 learning steps 压到最少。）
 */

const DAY = 24 * 60;

/** 阶段对应的复习间隔（单位：分钟）。下标即阶段号 */
const INTERVALS = [
  1 * DAY,   // 0  明天
  3 * DAY,   // 1
  7 * DAY,   // 2
  15 * DAY,  // 3
  30 * DAY,  // 4
  60 * DAY,  // 5  封顶，之后仍按 60 天滚动
];

const MAX_STAGE = INTERVALS.length - 1;

/** 「认识」往前跳几档 */
const EASY_JUMP = 2;
/** 「模糊」往前跳几档 —— 只升一档，与「认识」区分开 */
const VAGUE_JUMP = 1;

/**
 * 间隔 fuzz（抖动）：给较长的间隔加一点随机扰动，避免「同一批学的词
 * 永远在同一天一起到期」。
 *
 * 这个项目恰好是 fuzz 的高危场景：一批 5 个新词、按词频连续切 Unit、
 * 学习路径趋同 —— 如果都「一遍过」，它们会永远同时到期，某几天特别重、
 * 其他天特别空。（负载预测图能看到这个峰，但看到不等于消除。）
 *
 * 参数照抄 Anki 的实现（rslib/src/scheduler/states/fuzz.rs）：
 *   · 间隔 < 2.5 天不加扰动（短间隔抖动一下比例太大）
 *   · (2.5, 7] 天  → ±15%
 *   · (7, 20] 天   → ±10%
 *   · (20, +∞) 天  → ±5%
 *
 * 另外抄了它的一条保护规则，很关键：
 *   **不允许扰动之后比「上一次的间隔」还短** —— 否则会出现间隔倒退
 *   （比如上次 7 天、这次算出来 7 天，抖动后变成 6 天，等于白复习一轮）。
 */
const FUZZ_BANDS = [
  { maxDays: 2.5, factor: 0 },
  { maxDays: 7, factor: 0.15 },
  { maxDays: 20, factor: 0.1 },
  { maxDays: Infinity, factor: 0.05 },
];

/**
 * 给间隔加抖动。
 * @param {number} minutes    本次算出的间隔
 * @param {number} prevMinutes 上一次的间隔（用于「不许倒退」）。0 表示没有历史
 * @returns {number} 抖动后的间隔（分钟）
 */
function fuzzInterval(minutes, prevMinutes = 0) {
  const days = minutes / DAY;
  const band = FUZZ_BANDS.find((b) => days <= b.maxDays);
  if (!band || !band.factor) return minutes;

  const delta = minutes * band.factor;
  // 在 [minutes - delta, minutes + delta] 里取一个值
  const jittered = minutes + (Math.random() * 2 - 1) * delta;
  let out = Math.round(jittered);

  /*
   * 「不许倒退」：抖动之后不能**小于上一次的间隔**。
   *
   * 这一条很关键：固定表上相邻档位是 1→3→7→15→30→60，但抖动带最高到 ±15%，
   * 所以 7 天档往下抖有可能掉到 6 天以下 —— 而「上次」是 3 天时并不会触发问题，
   * 真正的问题是**同档位反复到期**时（本次 7 天、上次也是 7 天）抖成 6.x 天，
   * 等于这一轮白复习。
   *
   * 注意这里是「向上取」而不是「夹到区间内再抬」：
   * 直接把下界抬到 prevMinutes，会让间隔只能落在 [prev, base+delta]，
   * 虽然守住了纪律，但把负向抖动整个砍掉了。只在**越界时**才抬，
   * 保留正常范围内的正负抖动。
   */
  if (prevMinutes > 0 && out < prevMinutes) {
    out = Math.round(Math.max(out, Math.min(prevMinutes, minutes + delta)));
  }
  // 至少 1 天，且不超过 2 倍（防御性：正常参数下不会触发）
  return Math.min(Math.max(out, DAY), minutes * 2);
}

const RATING_LABEL = {
  known: '认识',
  vague: '模糊',
  unknown: '不认识',
};

/** 用当前时间构造 ISO 字符串 */
function nowIso() {
  return new Date().toISOString();
}

function addMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

/** 由阶段推导学习状态 */
function statusOf(stage, reps) {
  if (!reps) return 'new';
  if (stage >= 4) return 'mastered';
  if (stage >= 2) return 'reviewing';
  return 'learning';
}

/**
 * 依据反馈计算新的阶段与到期时间。
 *
 * 新词**没有 stage**，起点取 -1：这样「新词一遍就过」跳 2 档正好落到
 * 第 1 档（3 天），而不是 7 天。
 *
 * 判断新词要用 `status === 'new'` —— 因为 `getProgress()` 对没有记录的词
 * 会返回一个**默认对象**（stage 写死 0），只看 stage 会把新词当成第 0 档（踩过）。
 */
function schedule(progress, rating) {
  const prev = progress || {};
  const isNew = !prev.status || prev.status === 'new';
  const stage = isNew ? -1 : Number(prev.stage ?? 0);
  const reps = Number(prev.reps ?? 0);
  // 上一次的间隔（分钟），用于 fuzz 的「不许倒退」保护；新词或旧数据没有就是 0
  const prevStage = isNew ? -1 : stage;
  const prevDelay = prevStage >= 0 && prevStage <= MAX_STAGE ? INTERVALS[prevStage] : 0;

  let nextStage;
  let delay; // 分钟

  switch (rating) {
    case 'known':
      // 一遍就过：大步往后推
      nextStage = Math.min(Math.max(stage + EASY_JUMP, 0), MAX_STAGE);
      delay = INTERVALS[nextStage];
      break;

    case 'vague':
      /*
       * 模糊也算过关，但只往前 1 档。
       *
       * 以前是把模糊与不认识一起打回第 0 档，于是「模糊」这个按钮对排期
       * 毫无影响 —— 它只让 vague_count +1（参与顽固词判定），
       * 而用户看到的三档反馈里有一档是假的。
       * 三档反馈是同类项目（如 Engram）的核心设计；FSRS 里 Hard（≈模糊）
       * 也确实对应更小的稳定性增长。升 1 档正是这个意思，且完全零依赖。
       */
      nextStage = Math.min(Math.max(stage + VAGUE_JUMP, 0), MAX_STAGE);
      delay = INTERVALS[nextStage];
      break;

    case 'unknown':
      // 不认识：回到第 0 档，明天再来
      nextStage = 0;
      delay = INTERVALS[0];
      break;

    default:
      throw new Error(`未知的反馈类型: ${rating}`);
  }

  /*
   * 加抖动。
   *
   * 两个前提，缺一不可：
   *  1. **不是新词** —— 新词没有「上一次的间隔」，没有可比的下界
   *  2. **上一次不是 lapse**（答「不认识」）—— lapse 会把间隔打回第 0 档，
   *     那是一个**有意的**缩短；如果还拿「不许倒退」去卡它，
   *     一个从 30 天掉回 1 天的词会被硬拉长，惩罚就失效了
   */
  const isLapseRecovery = prev.last_rating === 'unknown';
  if (!isNew && !isLapseRecovery) {
    delay = fuzzInterval(delay, prevDelay);
  }

  const nextReps = reps + 1;

  return {
    stage: nextStage,
    reps: nextReps,
    delayMinutes: delay,
    due_at: addMinutes(delay),
    status: statusOf(nextStage, nextReps),
    last_rating: rating,
    last_review_at: nowIso(),
  };
}

/** 给前端展示用的间隔文案 */
function humanInterval(minutes) {
  if (minutes < 60) return `${minutes} 分钟后`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时后`;
  const d = Math.round(minutes / (24 * 60));
  if (d === 1) return '明天';
  return `${d} 天后`;
}

/**
 * 给「阶段分布」图表用的短标签，例如 0 → '1 天'、5 → '60 天'。
 *
 * 存在的意义是**别再让前端手抄一份间隔表**：
 * 以前 public/js/views/stats.js 里自己写死了 10 档标签
 * （'5 分钟','30 分钟','12 小时',…），排期改成 6 档日粒度之后没人改它，
 * 于是统计页把「明天复习」显示成「5 分钟」，和翻卡页的说法直接冲突。
 * 现在标签由这里统一生成、经接口下发，改间隔表不会再漏改前端。
 */
function stageLabel(minutes) {
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时`;
  const d = Math.round(minutes / (24 * 60));
  return `${d} 天`;
}

/** 全部阶段的短标签，下标即阶段号 */
function stageLabels() {
  return INTERVALS.map(stageLabel);
}

/** 阶段进度百分比，用于 UI 上的小进度条 */
function stagePercent(stage) {
  return Math.round((Math.min(Math.max(stage, 0), MAX_STAGE) / MAX_STAGE) * 100);
}

module.exports = {
  INTERVALS,
  MAX_STAGE,
  EASY_JUMP,
  VAGUE_JUMP,
  RATING_LABEL,
  schedule,
  fuzzInterval,
  statusOf,
  humanInterval,
  stageLabel,
  stageLabels,
  stagePercent,
  nowIso,
  addMinutes,
};
