'use strict';

/**
 * 复习排期。
 *
 * 规则是「日粒度 + 两档分化」：
 *   · 认识的词**一遍就过**，下次往前跳 2 档 —— 已经会的词不浪费时间
 *   · 不认识 / 模糊的词本轮循环到会，下次**明天**再来一遍
 *
 * 刻意**不用同一日内的短间隔**（以前有 5 分钟 / 30 分钟 / 12 小时三档）。
 * 那种设计会让当天反复到期：用户明明做完了，侧边栏徽标又涨回几十上百，
 * 看起来就像「没做完」。间隔一旦落在「天」上，就不会有这种自相矛盾。
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

/** 一遍就过时往前跳几档 */
const EASY_JUMP = 2;

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

  let nextStage;
  let delay; // 分钟

  switch (rating) {
    case 'known':
      // 一遍就过：大步往后推
      nextStage = Math.min(Math.max(stage + EASY_JUMP, 0), MAX_STAGE);
      delay = INTERVALS[nextStage];
      break;

    case 'vague':
    case 'unknown':
      // 模糊按「不认识」处理：回到明天重新来
      nextStage = 0;
      delay = INTERVALS[0];
      break;

    default:
      throw new Error(`未知的反馈类型: ${rating}`);
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
  RATING_LABEL,
  schedule,
  statusOf,
  humanInterval,
  stageLabel,
  stageLabels,
  stagePercent,
  nowIso,
  addMinutes,
};
