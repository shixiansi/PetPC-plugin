// lib/schedule.js —— "该不该说"全部是纯函数
//
// 为什么单独一个文件：这个插件最容易翻车的不是像素，是钟——机器休眠回来错过的点、跨午夜的
// 免打扰、凌晨两点算不算新的一天。这些都可以写成"给定 now 与 state 就有唯一答案"的函数，
// 于是用例能直接喂时间戳与 "HH:MM"，不用驱动 DOM、不用等 30 秒。app.js 那一侧只剩接线。
//
// 一句话的规则：**到点只说一次**。判定靠"上次说的时间 + 间隔"，不靠累加计数器——累加计数在
// 机器休眠/帧被重挂之后必然偏（手册 §3.9 第 4 条那句"1 秒轮询是反模式"是同一件事的另一面）。

'use strict';

/**
 * 本机几点算"新的一天"。
 *
 * 04:00 而不是 00:00：凌晨一点还在干活的人，那杯水不该算进"明天"，否则当天的提醒次数会在
 * 半夜突然清零、免打扰结束后的第一次判定也会跟着错位。这条与待办/习惯的切日规则一致。
 */
const DAY_ROLL_HOUR = 4;

/** pet.badge 的上限是 16 个字符（手册 §6.5）。这里再收一道，越界了就是宿主截断。 */
const BADGE_MAX = 16;

/**
 * 三条提醒。顺序就是界面上的顺序，也是同一拍里"一次说清"时的拼接顺序。
 *
 * `say` 收的是这一条的间隔分钟数：把它念出来，"45 分钟"就永远和设置里那一项是同一个数，
 * 而不是文案里再抄一遍。
 */
const KINDS = [
  {
    key: 'sit',
    label: '久坐',
    minutesKey: 'sitMinutes',
    onKey: 'sitEnabled',
    fallbackMinutes: 45,
    say: (n) => `已经坐了 ${n} 分钟，起来动一下`,
  },
  {
    key: 'water',
    label: '喝水',
    minutesKey: 'waterMinutes',
    onKey: 'waterEnabled',
    fallbackMinutes: 60,
    say: (n) => `该喝水了（${n} 分钟一次）`,
  },
  {
    key: 'eye',
    label: '护眼',
    minutesKey: 'eyeMinutes',
    onKey: 'eyeEnabled',
    fallbackMinutes: 20,
    say: () => '看一眼 6 米外，数 20 秒',
  },
];

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function boolOf(raw, fallback) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

function intOf(raw, min, max, fallback) {
  const n = Number.parseInt(String(raw === undefined || raw === null ? '' : raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * "HH:MM" → 从午夜起的分钟数；认不出来就回兜底值。
 *
 * 设置项是 `text`（宿主的表单里没有 time 类型），用户可能填 `8:00` / `08：00`（全角冒号）/
 * `晚上八点`。前两种收下，第三种回兜底——静默地变成"不设免打扰"比报错更糟，所以界面上
 * 会把**实际生效**的那一段写出来（见 workshop.js），用户一眼能看到自己填的有没有被认。
 */
function hhmm(raw, fallbackMinutes) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim().replace(/：/g, ':');
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  if (!m) return fallbackMinutes;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallbackMinutes;
  return h * 60 + mi;
}

/** 从午夜起的分钟数反写成 "HH:MM"（界面上写"实际生效的那一段"用）。 */
function mmhh(minutes) {
  const m = ((Number(minutes) || 0) % 1440 + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

/** 本机时区的"现在是几点几分"（0..1439）。免打扰与日界都按本机钟算，用户看到的就是它。 */
function minuteOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 免打扰判定：半开区间 [start, end)，跨午夜时按"或"接起来。
 *
 * 用半开区间是为了让端点只有一个含义：`08:00` 已经出了免打扰（用户写的"到 8 点"就是 8 点
 * 可以响），`07:59` 还在里面。两边相同 = 不设免打扰——把它当成 24 小时静音会让用户以为插件
 * 坏了，而界面上那一段会显示成同一个时间，看着就像没设置。
 */
function isQuiet(minute, startMinutes, endMinutes) {
  const start = Number(startMinutes);
  const end = Number(endMinutes);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
  if (start < end) return m >= start && m < end;
  return m >= start || m < end;
}

/**
 * 本机日期键（YYYY-MM-DD），按 DAY_ROLL_HOUR 切日。
 *
 * 实现是"把时钟往回拨 4 小时再取日期"：03:59 拨回去是前一天的 23:59，于是还叫昨天；
 * 04:00 拨回去是今天的 00:00，于是换了新的一天。用 UTC 或用 `toISOString().slice(0,10)`
 * 都会在非东八区偏一天，所以只碰本地字段。
 */
function dayKey(ms, rollHour) {
  const shift = (Number.isFinite(rollHour) ? rollHour : DAY_ROLL_HOUR) * 3600000;
  const d = new Date((Number.isFinite(ms) ? ms : Date.now()) - shift);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 把 manifest 里那几项原文（可能全是字符串，也可能缺）收成一份好用的形状。 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    items: KINDS.map((kind) => ({
      key: kind.key,
      label: kind.label,
      on: boolOf(src[kind.onKey], true),
      // 1 分钟到 600 分钟：再小就没有提醒的意义，再大就等于关掉了。
      minutes: intOf(src[kind.minutesKey], 1, 600, kind.fallbackMinutes),
      say: kind.say,
    })),
    quiet: {
      start: hhmm(src.quietStart, 22 * 60),
      end: hhmm(src.quietEnd, 8 * 60),
    },
  };
}

/** 空状态：`last[kind]` 缺席 = 还没起算（第一次判定时以"现在"为起点，不会一开机就连发三条）。 */
function emptyState() {
  return { day: '', last: {}, counts: {} };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 存储里读回来的东西 → 可用的状态。坏 JSON、旧格式、被手改过的值一律降级成空状态：
 * 提醒的代价是少说一句，而抛错的代价是整个帧什么都不做。
 */
function normalizeState(raw) {
  const src = typeof raw === 'string' ? safeParse(raw) : raw;
  const out = emptyState();
  if (!src || typeof src !== 'object') return out;
  if (typeof src.day === 'string') out.day = src.day;
  for (const kind of KINDS) {
    const last = Number(src.last && src.last[kind.key]);
    if (Number.isFinite(last) && last > 0) out.last[kind.key] = last;
    const count = Number(src.counts && src.counts[kind.key]);
    if (Number.isFinite(count) && count > 0) out.counts[kind.key] = Math.floor(count);
  }
  return out;
}

/** 两份状态是不是同一份。比字段而不是比 JSON：`last` 的键序会因为写入顺序不同而不同。 */
function sameState(a, b) {
  const x = normalizeState(a);
  const y = normalizeState(b);
  if (x.day !== y.day) return false;
  return KINDS.every(
    (kind) =>
      (Number(x.last[kind.key]) || 0) === (Number(y.last[kind.key]) || 0) &&
      (Number(x.counts[kind.key]) || 0) === (Number(y.counts[kind.key]) || 0),
  );
}

function clampRunes(text, max) {
  const runes = [...String(text === undefined || text === null ? '' : text)];
  return runes.length <= max ? runes.join('') : runes.slice(0, Math.max(0, max)).join('');
}

/**
 * 宠物头顶那一行（≤16 字符）。
 *
 * 优先级是"用户最需要知道的那一句"：全关 > 今天暂停 > 免打扰 > 下一条最近的还要多久。
 * 空串表示"清除徽标"，但这里**从不**返回空串——关掉三条时写"已停"，比什么都不显示更清楚
 * （用户关掉了东西，总得有一个地方承认这件事）。
 */
function badgeText(cfg, view) {
  const items = cfg.items || [];
  const on = items.filter((item) => item.on);
  if (!on.length) return '已停';
  if (view && view.paused) return '今天不提醒';
  if (view && view.quiet) return '免打扰中';
  const remaining = (view && view.remaining) || {};
  let best = on[0];
  for (const item of on) {
    if ((Number(remaining[item.key]) || 0) < (Number(remaining[best.key]) || 0)) best = item;
  }
  const minutes = Math.max(1, Math.ceil((Number(remaining[best.key]) || 0) / 60000));
  return clampRunes(`${best.label} ${minutes} 分`, BADGE_MAX);
}

/**
 * 一拍：给定状态、设置、此刻，算出「该说哪几句」、「新状态」、「徽标写什么」。
 *
 * 三件容易写错的事都在这里定死：
 *
 *   1. **越过了那个点只说一次**：说过就把 `last` 推到 now，下一次到期是 now+间隔，所以下一拍
 *      必然不再说，而下个间隔到点会再说一次。没有"已发过"的布尔标记——那种标记在休眠回来
 *      或者帧被重挂之后会永远停住。
 *   2. **关掉的一条不留计时**：`last` 写 0，等于"没起算"。再打开时以那一拍为起点，不会因为
 *      "关了三天"而一开机就补发。
 *   3. **免打扰里到点直接跳过、不补发**：`last` 同样推到 now。否则 08:00 一出门会连发三条，
 *      而那正是用户最不需要提醒的时刻。
 *
 * @param {object|string} rawState  storage 里那一份（可以是原文，也可以是解析后的对象）
 * @param {object|string} rawConfig config.get 的 `values`（可以没读过）
 * @param {number} now  此刻（epoch ms）
 * @param {boolean} paused  用户点了「今天先别提醒我」并且就是今天
 * @returns {{state: object, day: string, quiet: boolean, paused: boolean, fires: Array, remaining: object, badge: string}}
 */
function step(rawState, rawConfig, now, paused) {
  const cfg = rawConfig && rawConfig.items ? rawConfig : normalizeConfig(rawConfig);
  const at = Number.isFinite(now) ? now : Date.now();
  const state = normalizeState(rawState);
  const day = dayKey(at);

  // 跨日：次数清零、全部重新起算（"当天的已提醒次数"是给人看的，不能跨天累计）。
  if (state.day !== day) {
    state.day = day;
    state.last = {};
    state.counts = {};
  }

  const quiet = isQuiet(minuteOfDay(at), cfg.quiet.start, cfg.quiet.end);
  const fires = [];
  const remaining = {};

  for (const item of cfg.items) {
    const span = item.minutes * 60000;
    if (!item.on) {
      state.last[item.key] = 0;
      remaining[item.key] = span;
      continue;
    }
    const last = Number(state.last[item.key]) || 0;
    if (!last) {
      // 第一次（或者刚被打开）：以此刻为起点，不计入"到点"。
      state.last[item.key] = at;
      remaining[item.key] = span;
      continue;
    }
    const due = last + span;
    if (at < due) {
      remaining[item.key] = due - at;
      continue;
    }
    state.last[item.key] = at;
    remaining[item.key] = span;
    if (quiet || paused) continue;
    fires.push({ key: item.key, label: item.label, text: item.say(item.minutes) });
    state.counts[item.key] = (Number(state.counts[item.key]) || 0) + 1;
  }

  return {
    state,
    day,
    quiet,
    paused: Boolean(paused),
    fires,
    remaining,
    badge: badgeText(cfg, { quiet, paused: Boolean(paused), remaining }),
  };
}

// 测试接缝：`new Function('window','module', src)({}, {exports:{}})` 就能在 Node 里直接喂时间。
// 浏览器里没有 `module`，这一段不会执行（宿主也不给我们 require）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DAY_ROLL_HOUR,
    BADGE_MAX,
    KINDS,
    boolOf,
    intOf,
    hhmm,
    mmhh,
    minuteOfDay,
    isQuiet,
    dayKey,
    normalizeConfig,
    normalizeState,
    sameState,
    emptyState,
    clampRunes,
    badgeText,
    step,
  };
}
