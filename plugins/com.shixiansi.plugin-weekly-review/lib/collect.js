// lib/collect.js —— 三个来源，三路独立降级
//
// 素材全部来自**别的插件**，三条都走 `plugin.call`（手册 §6.8）。字段名是去对方的 app.js 里读出来
// 的（todo / pomodoro 的 handleStats、diary-writer 的 handleGetRecent），不是猜的：猜错的表现是
// "本地全绿、真机静默失效"。
//
//   com.shixiansi.plugin-todo/stats              → {total, done, open, dueToday, completionRate}
//   com.shixiansi.plugin-pomodoro/stats          → {focusMinutesToday, focusSessions, focusSessionsTotal}
//   com.shixiansi.plugin-diary-writer/get_recent → {entries:[{day, mood, text}]}   payload {limit}
//
// 每个来源都能单独挂：没装/没启用（宿主直接拒）、答了但字段不对、它自己报错。三种都必须写出
// **缺的是哪一块**，而不是让周报变成空壳。
//
// 关于"这一周"的诚实问题：待办的 stats 报的是**全部待办**（没有时间维度），番茄钟只报**今天**。
// 所以照它们的原话写（"今天专注 X 分钟"），绝不把今天的数改口成"本周"——那比缺一块更坏。
// 日记是唯一真的按周筛的：每条都有 day，按本周七个日键过一遍。

'use strict';

const TODO_TARGET = 'com.shixiansi.plugin-todo';
const FOCUS_TARGET = 'com.shixiansi.plugin-pomodoro';
const DIARY_TARGET = 'com.shixiansi.plugin-diary-writer';

/** 三个来源。`label` 是缺块句子里那个词（"这周没拿到专注数据"）。 */
const SOURCES = [
  {
    key: 'todo', label: '待办', plugin: '待办插件', from: '待办插件的 stats',
    target: TODO_TARGET, method: 'stats', payload: {}, read: readTodoStats,
  },
  {
    key: 'focus', label: '专注', plugin: '番茄钟插件', from: '番茄钟插件的 stats',
    target: FOCUS_TARGET, method: 'stats', payload: {}, read: readFocusStats,
  },
  {
    key: 'diary', label: '日记', plugin: '日记插件', from: '日记插件的 get_recent',
    target: DIARY_TARGET, method: 'get_recent', payload: { limit: 7 }, read: readDiaryRecent,
  },
];

/** 待办的四个数。任一必需字段不是非负整数就判定"答得不对"（宁可说缺，也不要写个 0 冒充）。 */
function readTodoStats(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  const total = numOr(out.total);
  const done = numOr(out.done);
  const open = numOr(out.open);
  if (total === null || done === null || open === null) return null;
  const declared = numOr(out.completionRate);
  // completionRate 它给了就用它的（那是它的口径）；没给就按 done/total 自己算一个。
  const rate = declared === null ? (total === 0 ? 0 : Math.round((done / total) * 100)) : Math.min(100, declared);
  const dueToday = numOr(out.dueToday);
  return { total, done, open, rate, dueToday: dueToday === null ? 0 : dueToday };
}

/** 番茄钟的三个数：今天专注多少分钟、今天几段、累计几段。 */
function readFocusStats(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  const minutes = numOr(out.focusMinutesToday);
  const sessions = numOr(out.focusSessions);
  if (minutes === null || sessions === null) return null;
  const totalSessions = numOr(out.focusSessionsTotal);
  return { minutes, sessions, totalSessions: totalSessions === null ? sessions : totalSessions };
}

/**
 * 日记的最近几篇 → 本周那几篇。`entries` 不是数组就是"答得不对"；空数组是**有效答案**
 * （这周确实没写），两者在报告里完全不同。
 */
function readDiaryRecent(out, range) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.entries)) return null;
  const week = [];
  for (const entry of out.entries) {
    if (!entry || typeof entry !== 'object') continue;
    const day = typeof entry.day === 'string' ? entry.day : '';
    if (!dayInRange(range, day)) continue;
    week.push({ day, mood: typeof entry.mood === 'string' ? entry.mood : '', text: typeof entry.text === 'string' ? entry.text : '' });
  }
  // 平台给的顺序不保证；按日键排一遍，模板里"挑一篇"才是这周最后写的那篇。
  week.sort((a, b) => a.day.localeCompare(b.day));
  return { count: week.length, entries: week };
}

/** 把宿主那句错误归类。分类只为了写出人话，不决定要不要重试（周报没有重试）。 */
function classifyError(err) {
  const line = msgOf(err);
  if (/未安装|没装|未启用|无此目标|问不到|找不到|没有这个插件|插件不存在/.test(line)) return 'missing';
  if (/超时|timeout/i.test(line)) return 'timeout';
  return 'failed';
}

const CAUSE = { bad: '答得不对', missing: '没装或没启用', timeout: '没答上来', failed: '报错了' };

/** 缺块的人话。报告正文、卡片、插件页三处共用这一句，免得三处说法打架。 */
function missingLine(source, state) {
  return `这周没拿到${source.label}数据（${source.plugin}${CAUSE[state.reason] || CAUSE.failed}）`;
}

/** 问一个来源；三种失败都变成一条状态，绝不让一次失败拖死整份周报。 */
async function askSource(source, range) {
  if (!granted.has('plugin.call')) {
    return { state: 'error', reason: 'failed', detail: '未获授权 plugin.call，问不到任何插件' };
  }
  let out;
  try {
    out = await request('plugin.call', { target: source.target, method: source.method, payload: source.payload });
  } catch (err) {
    return { state: 'error', reason: classifyError(err), detail: msgOf(err) };
  }
  let data = null;
  try {
    data = source.read(out, range);
  } catch {
    data = null;
  }
  if (!data) return { state: 'bad', reason: 'bad', detail: `返回的字段不是 ${source.from} 承诺的形状` };
  return { state: 'ok', data };
}

/**
 * 收集这一周（三个来源并行问：三个都装好了也只要一次往返的延迟）。
 *
 * @returns {Promise<object>} {range, sources, missing, numbers, diary}
 *   `numbers` 里每项要么是个数，要么是 null（= 这块没拿到）。null 与 0 是两件事。
 */
async function collectWeek(range) {
  const outcomes = await Promise.all(SOURCES.map((source) => askSource(source, range)));
  const sources = {};
  const missing = [];
  SOURCES.forEach((source, i) => {
    const state = outcomes[i];
    sources[source.key] = state;
    if (state.state !== 'ok') {
      const { reason, detail } = state;
      missing.push({ key: source.key, label: source.label, plugin: source.plugin, reason, detail, line: missingLine(source, state) });
    }
  });
  const ok = (key) => (sources[key].state === 'ok' ? sources[key].data : null);
  const todo = ok('todo');
  const focus = ok('focus');
  const diary = ok('diary');
  return {
    range,
    sources,
    missing,
    diary: diary ? diary.entries : [],
    numbers: {
      todoTotal: todo ? todo.total : null,
      todoDone: todo ? todo.done : null,
      todoOpen: todo ? todo.open : null,
      todoRate: todo ? todo.rate : null,
      focusMinutes: focus ? focus.minutes : null,
      focusSessions: focus ? focus.sessions : null,
      diaryCount: diary ? diary.count : null,
    },
  };
}
