// 习惯打卡的纯函数层：换日、streak、状态解析与改动。
//
// 这里不碰宿主、不碰 DOM、不取当前时间——"现在几点"由调用方传进来（epoch 毫秒 +
// 本地偏移 + 换日钟点）。测试接缝在 app.js 的 __habits.setClock；本文件自己就是
// window.HabitCore（panel.html 用 <script> 引入，测试用 new Function 装载同一份）。
//
// streak 的定义（决定"断签只重置一次"怎么实现）：
//   连续打卡天数 = 从今天（今天没打则从昨天）往前数的连续有卡天数。
//   它是 log + 今天 key 的**纯函数**——没有任何持久化的"已重置"标记，
//   断签不需要被"执行"一次，自然也就不会执行第二次（两次查询结果逐字相同）。
'use strict';

(function () {
  const MS_MIN = 60000;
  const MS_DAY = 86400000;

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /**
   * 某一时刻属于哪个"习惯日"。
   * 换日点 dayChangeHour（0–23）：本机那天 03:59 仍算前一天、04:01 起算新的一天。
   * 做法：把墙钟（epoch + 本地偏移）往回拨换日钟点，再取日期——跨月/跨年由 Date.UTC 兜底。
   */
  function dayKeyOf(ms, dayChangeHour, offsetMin) {
    const hour = Number(dayChangeHour);
    const safeHour = Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.floor(hour))) : 4;
    const shifted = ms + offsetMin * MS_MIN - safeHour * 3600000;
    const d = new Date(shifted);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  /** 前一天的 day key。只吃 YYYY-MM-DD；别的形状返回空串。 */
  function prevDayKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return '';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    d.setUTCDate(d.getUTCDate() - 1);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  /**
   * 某习惯的连续天数。days 是该习惯打过卡的 day key 列表（顺序无关，内部去重）。
   * 今天有卡 → 从今天往前数；今天没卡 → 从昨天往前数（今天还没过完，不算断）；
   * 昨天也没卡 → 0（这就是"断签归零"，再查一遍还是 0）。
   */
  function streakOf(days, todayKey) {
    if (!DAY_RE.test(String(todayKey || ''))) return 0;
    const set = new Set(days || []);
    let cursor = todayKey;
    if (!set.has(cursor)) {
      cursor = prevDayKey(todayKey);
      if (!cursor || !set.has(cursor)) return 0;
    }
    let streak = 0;
    while (set.has(cursor)) {
      streak += 1;
      cursor = prevDayKey(cursor);
      if (streak > 3650) break; // 十年的连击到头了，防脏数据把循环拖死
    }
    return streak;
  }

  const emptyState = () => ({ habits: [], log: {} });

  /** 读回 storage 里的状态：任何畸形输入都落到空状态，绝不抛错。 */
  function parseState(text) {
    if (!text) return emptyState();
    let v;
    try { v = JSON.parse(String(text)); } catch { return emptyState(); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return emptyState();
    const habits = Array.isArray(v.habits)
      ? v.habits
        .filter((h) => h && typeof h.id === 'string' && typeof h.name === 'string' && h.id && h.name)
        .map((h) => ({ id: h.id, name: h.name }))
      : [];
    const log = {};
    const src = v.log && typeof v.log === 'object' && !Array.isArray(v.log) ? v.log : {};
    for (const id of Object.keys(src)) {
      if (!Array.isArray(src[id])) continue;
      const days = [...new Set(src[id].filter((d) => typeof d === 'string' && DAY_RE.test(d)))].sort();
      if (days.length > 0) log[id] = days;
    }
    return { habits, log };
  }

  /** 每个习惯的今日完成与连续天数（+ 整体进度）。todayKey 由调用方算好传入。 */
  function summarize(state, todayKey) {
    const habits = state.habits.map((h) => {
      const days = state.log[h.id] || [];
      return {
        id: h.id,
        name: h.name,
        streak: streakOf(days, todayKey),
        doneToday: days.indexOf(todayKey) >= 0,
        lastDay: days.length > 0 ? days[days.length - 1] : '',
      };
    });
    const done = habits.filter((h) => h.doneToday).length;
    return {
      day: todayKey,
      total: habits.length,
      done,
      remaining: habits.length - done,
      habits,
    };
  }

  /** 打卡/取消打卡（纯函数：返回新状态，不改入参）。 */
  function withCheck(state, id, dayKey, on) {
    const days = new Set(state.log[id] || []);
    if (on) days.add(dayKey); else days.delete(dayKey);
    return {
      habits: state.habits.map((h) => ({ id: h.id, name: h.name })),
      log: { ...state.log, [id]: [...days].sort() },
    };
  }

  function withHabitAdded(state, id, name) {
    if (state.habits.some((h) => h.id === id)) {
      return { habits: state.habits.map((h) => ({ ...h })), log: { ...state.log } };
    }
    return {
      habits: [...state.habits.map((h) => ({ ...h })), { id, name }],
      log: { ...state.log },
    };
  }

  /** 删习惯时把它的打卡记录一并带走（同一个写者，顺手清理，不留孤儿键）。 */
  function withHabitRemoved(state, id) {
    const log = { ...state.log };
    delete log[id];
    return { habits: state.habits.filter((h) => h.id !== id).map((h) => ({ ...h })), log };
  }

  window.HabitCore = Object.freeze({
    MS_MIN,
    MS_DAY,
    dayKeyOf,
    prevDayKey,
    streakOf,
    parseState,
    summarize,
    withCheck,
    withHabitAdded,
    withHabitRemoved,
  });
})();
