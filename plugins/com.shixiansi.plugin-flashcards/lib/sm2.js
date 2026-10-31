// lib/sm2.js —— SuperMemo-2 间隔重复算法（纯手写，无依赖）
//
// 原版 SM-2（1987）的规则：
//   - 质量分 q ∈ {0(忘记) 1..5}；本插件映射四键：忘记=0、困难=3、良好=4、简单=5。
//   - q < 3（忘记）： repetitions=0、interval=1（天）、ef 不变（原版如此——EF 只在
//     q>=3 时更新；「忘记重置间隔但不重置 EF」是 SM-2 的本意：EF 记录的是"这张卡
//     对你多难"的长期统计）。
//   - q >= 3：repetitions +1；第一次 interval=1，第二次 interval=6，之后
//     interval = round(interval * EF)。
//   - EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))，下限 1.3。
//   - due = now + interval 天。
//
// 测试钉死的行为（题目要求）：
//   - 连续"完美反馈"（简单 q=5）间隔指数增长：1 → 6 → 13.8 → 20.7 …（EF 1.3→2.5 上限）
//   - "完全忘记"重置到 1 天，repetitions 归零；EF 只在困难反馈下轻微下降，
//     忘记本身不降 EF（原版语义）。

'use strict';

const SM2_MIN_EF = 1.3;
const SM2_MAX_EF = 2.8;   // 原版没有上限，但 2.8 以上间隔增长失真（工程上限）
const SM2_START_EF = 2.5;

/** 四键反馈 → 质量分。 */
const GRADES = {
  forget: { q: 0, label: '忘记' },
  hard: { q: 3, label: '困难' },
  good: { q: 4, label: '良好' },
  easy: { q: 5, label: '简单' },
};

/** EF 更新公式（q>=3 时用）。 */
function nextEF(ef, q) {
  const e = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  return Math.min(SM2_MAX_EF, Math.max(SM2_MIN_EF, Math.round(e * 1000) / 1000));
}

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * SM-2 的核心步骤。
 * @param {object} card {ef, interval(天), repetitions, due(毫秒 epoch)}——缺字段按新卡
 * @param {string} grade 'forget'|'hard'|'good'|'easy'
 * @param {number} [now] 毫秒 epoch（测试注入时钟）
 * @returns {{ef, interval, repetitions, due, lastGrade}}
 */
function sm2Review(card, grade, now = Date.now()) {
  const g = GRADES[grade];
  if (!g) throw new Error(`未知反馈 ${grade}（只认 forget/hard/good/easy）`);
  const ef = Number(card.ef) || SM2_START_EF;
  let repetitions = Math.max(0, Math.floor(Number(card.repetitions) || 0));
  let interval = Math.max(0, Math.floor(Number(card.interval) || 0));

  if (g.q < 3) {
    // 忘记：重置序列，间隔回到 1 天。EF 不变（原版语义）。
    repetitions = 0;
    interval = 1;
  } else {
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.max(1, Math.round(interval * nextEF(ef, g.q)));
    // interval 保险丝：40 年（谁也不想复习一张卡等到下辈子）。
    interval = Math.min(interval, 365 * 40);
  }

  const newEf = g.q < 3 ? ef : nextEF(ef, g.q);
  return {
    ef: newEf,
    interval,
    repetitions,
    due: now + interval * DAY_MS,
    lastGrade: grade,
  };
}

/** 到期判断。没有 due 字段的卡（异常卡）不算到期。 */
function sm2IsDue(card, now = Date.now()) {
  if (!card || card.due === undefined || card.due === null) return false;
  return (Number(card.due) || 0) <= now;
}

/** 到期还有多久（毫秒；已到期为 0）。 */
function sm2TimeToDue(card, now = Date.now()) {
  return Math.max(0, (Number(card.due) || 0) - now);
}

/** 学完一批之后，下一张该复习的时间（队列里最早的 due）。 */
function sm2NextDueDate(cards, now = Date.now()) {
  let min = Infinity;
  for (const c of cards) {
    const d = Number(c.due) || 0;
    if (d > now && d < min) min = d;
  }
  return Number.isFinite(min) ? min : null;
}

const SM2 = {
  SM2_MIN_EF, SM2_MAX_EF, SM2_START_EF, GRADES, DAY_MS,
  sm2Review, sm2IsDue, sm2TimeToDue, sm2NextDueDate, nextEF,
};
