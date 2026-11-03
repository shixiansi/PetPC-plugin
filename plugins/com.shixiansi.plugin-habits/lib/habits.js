// lib/habits.js —— 习惯打卡的领域逻辑，**全部是纯函数**。
//
// 为什么单独一层且时间必须由调用方喂进来（`now` 参数）：
//
//   1. 「哪天算哪天」是这个插件的全部正确性所在，而它只能在边界上出错——03:59 与 04:00、
//      1/31 与 2/1、12/31 与 1/1。这些用真时钟测不了（一年只有一次 12/31），所以换日、
//      连续性、提醒判定都做成"给我一个时刻，我告诉你答案"的纯函数，用例直接喂时间。
//   2. 同一份状态会被**多个文档**分别算一遍（宠物旁的卡片、控制中心的页、常驻帧各一份），
//      所以"算一次"必须是幂等的：同一天算两遍不能让连续天数清零，也不能把同一格记两次。
//
// 状态形状（存在 storage 的一个键里，见 lib/store.js）：
//
//   {
//     version: 1,
//     habits: [{id, name}],        // 每天要做的习惯
//     streak: 0,                   // 截至 closedThrough 的连续完成天数
//     best: 0,                     // 历史最长
//     closedThrough: "2026-11-02",  // 结算游标：这一天及之前都已经结算完
//     done: {"2026-11-03": ["h1"]}, // 每天的打卡格（只留最近 HISTORY_DAYS 天）
//     lastRemindDay: "2026-11-03"   // 今天这天提醒过没有
//   }

'use strict';

/** 换日时刻：本机 04:00。03:59 仍属于前一天，04:00 属于新的一天。 */
const HABIT_DAY_START_HOUR = 4;
const STATE_VERSION = 1;
/** 打卡格保留多少天。够回答「最近怎么样」，又不至于让一个键无界长大。 */
const HISTORY_DAYS = 60;
/** 头顶那行字的硬上限（宿主只画、不解析，超长会被它截断）。 */
const BADGE_MAX = 16;
const REMIND_DEFAULT_MINUTES = 20 * 60;

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) ? n : Date.now();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/**
 * 这一刻属于哪一个"习惯日"。
 *
 * 做法是把钟往回拨 4 小时再取日期：03:59 拨回去是前一天 23:59，04:00 拨回去是当天 00:00。
 * 比"逐条 if (h < 4)"少一个分支，也不会在月末边界上写错。
 */
function dayKey(now) {
  const date = new Date(toMs(now));
  date.setHours(date.getHours() - HABIT_DAY_START_HOUR);
  return ymd(date);
}

/** "YYYY-MM-DD" → Date（锚在当天中午，夏令时把 00:00 挪走也不会跨日）。 */
function dayDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

/**
 * 日期加减，**只用 Date 运算**。
 *
 * 这条是硬来的：`"2026-01-31" + 1 天` 与 `"2026-12-31" + 1 天` 都不是"字符串减一减"能算出来的，
 * 而连续天数的判定正好落在两个跨年边界上。所以这里只把 day 串当成 Date 的钥匙。
 */
function addDays(day, days) {
  const date = dayDate(day);
  if (!date) return '';
  date.setDate(date.getDate() + Number(days || 0));
  return ymd(date);
}

function nextDay(day) {
  return addDays(day, 1);
}

/** 两个 day 串相差几天（b 比 a 晚为正）。 */
function dayGap(from, to) {
  const a = dayDate(from);
  const b = dayDate(to);
  if (!a || !b) return NaN;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function unique(list) {
  const out = [];
  for (const item of list) if (out.indexOf(item) < 0) out.push(item);
  return out;
}

function emptyState() {
  return {
    version: STATE_VERSION,
    habits: [],
    streak: 0,
    best: 0,
    closedThrough: '',
    done: {},
    lastRemindDay: '',
  };
}

/**
 * 把存储里读到的东西变成一份形状确定的状态。
 *
 * 会静默丢掉不认识的格子：这是用户自己的数据，坏一个字段不该让整个插件停摆
 * （storage 里那一格可能是半年前的另一版写下的）。
 */
function normalizeState(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
  }
  const out = emptyState();
  if (!parsed || typeof parsed !== 'object') return out;

  const habits = [];
  for (const item of Array.isArray(parsed.habits) ? parsed.habits : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const name = String(item.name || '').trim();
    if (!id || !name) continue;
    if (habits.some((h) => h.id === id)) continue;
    habits.push({ id, name: name.slice(0, 24) });
  }
  out.habits = habits;
  out.streak = Math.max(0, Number(parsed.streak) || 0);
  out.best = Math.max(out.streak, Number(parsed.best) || 0);
  out.closedThrough = dayDate(parsed.closedThrough) ? String(parsed.closedThrough) : '';
  out.lastRemindDay = typeof parsed.lastRemindDay === 'string' ? parsed.lastRemindDay : '';

  const done = {};
  const src = parsed.done && typeof parsed.done === 'object' ? parsed.done : {};
  for (const day of Object.keys(src)) {
    if (!dayDate(day)) continue;
    const ids = (Array.isArray(src[day]) ? src[day] : []).map((id) => String(id));
    // 只留还存在的习惯：删掉一个习惯，不该在历史里留一条谁也看不见的格子。
    done[day] = unique(ids.filter((id) => habits.some((h) => h.id === id)));
  }
  out.done = done;
  return out;
}

function serializeState(state) {
  return JSON.stringify(normalizeState(state));
}

function habitsOf(state) {
  return state && Array.isArray(state.habits) ? state.habits : [];
}

function doneOn(state, day) {
  const list = state && state.done ? state.done[day] : null;
  return Array.isArray(list) ? list : [];
}

function isDone(state, day, id) {
  return doneOn(state, day).indexOf(id) >= 0;
}

/** 这一天算不算"打满了"：至少一个习惯，且每个都打过。 */
function isDayComplete(state, day) {
  const habits = habitsOf(state);
  if (!habits.length) return false;
  return habits.every((h) => isDone(state, day, h.id));
}

function pendingCount(state, day) {
  return habitsOf(state).filter((h) => !isDone(state, day, h.id)).length;
}

function prune(state, today) {
  const cut = addDays(today, -HISTORY_DAYS);
  if (!cut) return;
  for (const day of Object.keys(state.done)) {
    // 零填充的 ISO 日期串可以直接比大小；这里用的是**顺序**，不是日期算术。
    if (day < cut) delete state.done[day];
  }
}

/**
 * 把游标推进到今天之前，一路上把过去那些天结算成"完成 / 断签"。
 *
 * 幂等是怎么来的：游标停在 `closedThrough`（那一天及之前都结算过），所以同一天再算一遍时
 * `closedThrough + 1 >= today`，循环一次都不进，streak 一个字节都不动。这就是
 * 「同一天打开两次、卡片和常驻帧各算一次都不会把连续天数反复清零」的全部机制。
 *
 * 时钟被用户拨回去时游标会停在今天之后：那时**什么都不做**（不是把游标拉回来——拉回来会让
 * 昨天被重复结算一次，连续天数会凭空 +1）。
 */
function settle(state, now) {
  const next = normalizeState(state);
  const today = dayKey(now);
  if (!next.closedThrough) {
    // 第一次记账：之前的日子不存在，不该被算成断签。
    next.closedThrough = addDays(today, -1);
    prune(next, today);
    return next;
  }
  let cursor = nextDay(next.closedThrough);
  let guard = 0;
  while (cursor && cursor < today && guard < 400) {
    if (isDayComplete(next, cursor)) {
      next.streak += 1;
      if (next.streak > next.best) next.best = next.streak;
    } else {
      next.streak = 0;
    }
    next.closedThrough = cursor;
    cursor = nextDay(cursor);
    guard += 1;
  }
  prune(next, today);
  return next;
}

/** 今天（或指定 day）已经打满了吗——界面上要分支的那件事。 */
function todayDone(state, now) {
  return isDayComplete(normalizeState(state), dayKey(now));
}

/** 最近一个"打满"的日子；找不到就是空串。 */
function lastCompleteDay(state, today) {
  let day = today;
  for (let i = 0; i <= HISTORY_DAYS; i += 1) {
    if (isDayComplete(state, day)) return day;
    day = addDays(day, -1);
    if (!day) break;
  }
  return '';
}

/**
 * 连续天数（给界面与 serves.streak 用的是同一份）。
 *
 * `streak` 只算到昨天为止（今天是"还没过完"的一天），今天打满时**显示**要 +1——
 * 否则用户刚打完最后一件，头顶还写着昨天的数字，看起来像没记上。
 */
function streakInfo(state, now) {
  const settled = settle(state, now);
  const today = dayKey(now);
  const complete = isDayComplete(settled, today);
  const streak = complete ? settled.streak + 1 : settled.streak;
  const best = Math.max(settled.best, streak);
  const lastDay = complete ? today : lastCompleteDay(settled, today);
  return { streak, best, lastDay, todayComplete: complete };
}

/** 今天那一屏：形状就是 serves.today 的返回（宿主与界面共用一份）。 */
function todayInfo(state, now) {
  const settled = settle(state, now);
  const day = dayKey(now);
  const items = habitsOf(settled).map((h) => ({ id: h.id, name: h.name, done: isDone(settled, day, h.id) }));
  return { day, items, pending: items.filter((item) => !item.done).length };
}

/**
 * 打卡 / 取消打卡。返回是否真的改了东西——"同一格重复打卡"必须返回 false，
 * 否则每一次重复都会写一遍存储、并让宿主推一条 storage.changed（两个帧各重画一次）。
 */
function setDone(state, id, day, done) {
  const next = normalizeState(state);
  if (!habitsOf(next).some((h) => h.id === id)) return null;
  const list = doneOn(next, day).slice();
  const at = list.indexOf(id);
  if (done && at < 0) list.push(id);
  else if (!done && at >= 0) list.splice(at, 1);
  else return null; // 已经是这个状态：不算改动
  next.done[day] = list;
  return next;
}

function toggleDone(state, id, now) {
  const day = dayKey(now);
  const next = normalizeState(state);
  return setDone(next, id, day, !isDone(next, day, id));
}

/** 加一个习惯。id 由调用方给（用例里要可预测，界面上是时间戳）。 */
function addHabit(state, name, id) {
  const label = String(name || '').trim().slice(0, 24);
  const next = normalizeState(state);
  if (!label) return null;
  const key = String(id || '').trim();
  if (!key || habitsOf(next).some((h) => h.id === key)) return null;
  next.habits = next.habits.concat([{ id: key, name: label }]);
  return next;
}

function removeHabit(state, id) {
  const next = normalizeState(state);
  if (!habitsOf(next).some((h) => h.id === id)) return null;
  next.habits = next.habits.filter((h) => h.id !== id);
  // 历史里那一格一起清掉（normalizeState 也会滤，这里是显式的意图）。
  for (const day of Object.keys(next.done)) {
    next.done[day] = next.done[day].filter((x) => x !== id);
  }
  return next;
}

function clipBadge(text) {
  return Array.from(String(text || '')).slice(0, BADGE_MAX).join('');
}

/**
 * 头顶那行字。**≤16 字符**，空串等于清除。
 *
 * 它只说一件事：要么"连续 N 天"，要么"今天还差 N 件"（用户在设置里选）。没有习惯时给空串，
 * 让宿主的清除语义生效——一只头顶写着"连续 0 天"的宠物比不写更糟。
 */
function badgeText(state, now, mode) {
  const today = todayInfo(state, now);
  if (!today.items.length) return '';
  const info = streakInfo(state, now);
  const streakLine = info.streak > 0 ? `连续 ${info.streak} 天` : `今天还差 ${today.pending} 件`;
  const pendingLine =
    today.pending > 0 ? `今天还差 ${today.pending} 件` : info.streak > 0 ? `连续 ${info.streak} 天` : '今天已完成';
  return clipBadge(mode === 'pending' ? pendingLine : streakLine);
}

function parseClock(text, fallbackMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return fallbackMinutes;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!(hours >= 0 && hours <= 23) || !(minutes >= 0 && minutes <= 59)) return fallbackMinutes;
  return hours * 60 + minutes;
}

/** 从"习惯日"的 04:00 起过了多少分钟（0..1439）。 */
function minutesIntoHabitDay(now) {
  const date = new Date(toMs(now));
  return ((date.getHours() * 60 + date.getMinutes()) - HABIT_DAY_START_HOUR * 60 + 1440) % 1440;
}

/**
 * 现在该不该提醒。
 *
 * 两条判定缺一不可：
 *   1. **到点了没有**——把配置里的钟点也换算成"从 04:00 起多少分钟"，于是 20:00 与 03:30
 *      两种写法都对（后者属于同一天的尾巴）。
 *   2. **今天这一天提醒过没有**——`lastRemindDay`。定时器每 30 秒看一次，没有这一条就会在
 *      到点之后的每一拍各提醒一次；而帧被重挂（用户改授权、换版本）后内存里什么都不剩，
 *      所以这条必须跟着状态落进 storage。
 */
function reminderDue(state, now, clockText) {
  const atMinutes = parseClock(clockText, REMIND_DEFAULT_MINUTES);
  const atInto = (atMinutes - HABIT_DAY_START_HOUR * 60 + 1440) % 1440;
  const nowInto = minutesIntoHabitDay(now);
  if (nowInto < atInto) return false;
  const day = dayKey(now);
  if (state && state.lastRemindDay === day) return false;
  const next = settle(state, now);
  if (!habitsOf(next).length) return false;
  return pendingCount(next, day) > 0;
}
