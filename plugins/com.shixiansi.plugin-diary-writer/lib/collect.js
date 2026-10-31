// lib/collect.js —— 当天碎片的三路聚合
//
// 日记的原材料来自三个邻居，三条路各走各的协议（手册 §6.7 / §6.8）：
//
//   1. 记忆核心（memcore/export-state，plugin.call）——分层记忆的完整快照，里面
//      mem/role/<会话>/chain 是今天说过的话（kind: in/out/summary/...）；
//   2. 待办插件（todo/todo-list，plugin.share）——实时的待办快照，取 done 的那些；
//   3. 番茄钟（pomodoro/phase-ended，plugin.share）——最后一段结束的时刻与类型，
//      再加上我们自己在 share 上攒的"今天完成了几段专注"计数。
//
// 聚合是**防御性**的：三个邻居都可能没装、没授权、快照是空的、或快照是三天前的。
// 每一路独立降级，缺哪块日记就少哪段，绝不让一次聚合失败拖死整篇日记。

'use strict';

const MEMCORE_TARGET = 'com.shixiansi.plugin-memcore';
const MEMCORE_METHOD = 'export-state';

const TODO_OWNER = 'com.shixiansi.plugin-todo';
const TODO_NAME = 'todo-list';
const POMODORO_OWNER = 'com.shixiansi.plugin-pomodoro';
const POMODORO_NAME = 'phase-ended';

/** 我们自己攒的"今天专注了几段"（每个 phase-ended 事件 +1）。 */
const KEY_FOCUS_TODAY = 'collect/focus-today';
/** 上一次聚合到的 phase-ended 时间戳（去重：同一事件只算一次）。 */
const KEY_FOCUS_SEEN = 'collect/focus-seen';

/** 本地日期（YYYY-MM-DD）：日记按天归档的键。宿主时钟是本地时区。 */
function dayKeyOf(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : now());
  const pad = (x) => `${x}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 昨天的 dayKey（用于"昨天的日记"）。 */
function yesterdayKey(ms) {
  return dayKeyOf((Number.isFinite(ms) ? ms : now()) - 24 * 3600 * 1000);
}

// --- 路 1：记忆核心 ---------------------------------------------------------------

/** export-state 快照里挑出今天的对话事件（chain 事件）。 */
function eventsTodayFromSnapshot(snapshot, today) {
  const out = [];
  const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
  for (const entry of entries) {
    if (!entry || !String(entry.key || '').startsWith('mem/role/')) continue;
    if (!String(entry.key || '').endsWith('/chain')) continue;
    const chain = Array.isArray(entry.value) ? entry.value : [];
    for (const event of chain) {
      if (!event || typeof event !== 'object') continue;
      if (dayKeyOf(Number(event.at) || 0) !== today) continue;
      out.push(event);
    }
  }
  return out;
}

/** 今天的事件 → 给模型读的素材行（压缩到 ~600 字预算内）。 */
function summarizeEvents(events, budget) {
  const lines = [];
  for (const event of events) {
    if (event.kind === 'in') lines.push(`${event.who || '主人'}说：${text(event.text, 80)}`);
    else if (event.kind === 'out') lines.push(`我答：${text(event.text, 80)}`);
    else if (event.kind === 'summary') lines.push(`阶段性小结：${text(event.text, 80)}`);
    if (lines.join('\n').length >= budget) break;
  }
  return lines.slice(0, 40);
}

// --- 路 2/3：共享牌盘 -------------------------------------------------------------

/** 读一个共享键；没装/没授权/没写过都返回 null（轮询的第一拍就是空）。 */
async function readShared(owner, name) {
  try {
    const out = await request('share.get', { owner, name });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 待办快照 → {done: [...], pending: n}；快照坏了按空处理。 */
function todosFromSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) return { done: [], pending: 0 };
  const done = snapshot
    .filter((t) => t && t.done && typeof t.title === 'string' && t.title.trim())
    .map((t) => text(t.title, 60));
  const pending = snapshot.filter((t) => t && !t.done).length;
  return { done: done.slice(0, 12), pending };
}

/**
 * 番茄钟的 phase-ended：牌盘上只有"最后一段"。我们自己数数——
 * 每次见到比上次新的 at，就把今天 +1；跨天清零。
 */
async function countFocusToday() {
  const last = await readShared(POMODORO_OWNER, POMODORO_NAME);
  const seen = await readJSON(KEY_FOCUS_SEEN, { at: 0 });
  const today = await readJSON(KEY_FOCUS_TODAY, { day: '', focus: 0 });

  const today0 = today && today.day === dayKeyOf(now()) ? today : { day: dayKeyOf(now()), focus: 0 };
  const lastAt = last && Number(last.at) ? Number(last.at) : 0;
  if (lastAt && last.phase === 'focus' && lastAt > (Number(seen.at) || 0)) {
    today0.focus += 1;
    await writeJSON(KEY_FOCUS_SEEN, { at: lastAt });
    await writeJSON(KEY_FOCUS_TODAY, today0);
  }
  return Math.max(0, Number(today0.focus) || 0);
}

// --- 聚合本体 ----------------------------------------------------------------------

/**
 * 收集今天的所有素材。
 *
 * @returns {Promise<object>} {day, hasAny, chat: [行], todosDone: [...], todosPending, focusCount, memOk}
 */
async function collectToday(budget) {
  await refreshConfig();
  const day = dayKeyOf(now());

  // 路 1：记忆核心（plugin.call；没装/没授权 → null）。
  let memOk = false;
  let chat = [];
  try {
    const snapshot = await request('plugin.call', { target: MEMCORE_TARGET, method: MEMCORE_METHOD, payload: {} });
    const events = eventsTodayFromSnapshot(snapshot, day);
    chat = summarizeEvents(events, budget);
    memOk = events.length > 0 || Array.isArray(snapshot && snapshot.entries);
  } catch {
    memOk = false;
  }

  // 路 2/3：牌盘（share.get；空值返回 null，不是错误）。
  const [todoSnapshot] = await Promise.all([
    readShared(TODO_OWNER, TODO_NAME),
    countFocusToday(),
  ]);
  const todos = todosFromSnapshot(todoSnapshot);
  const focusCount = await countFocusToday();

  return {
    day,
    hasAny: chat.length > 0 || todos.done.length > 0 || focusCount > 0,
    chat,
    todosDone: todos.done,
    todosPending: todos.pending,
    focusCount,
    memOk,
  };
}

/** 本地 HH:mm 解析（diaryTime 配置）；非法值回 23:00。 */
function parseDiaryTime(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 23, min: 0 };
  const h = clampInt(m[1], 0, 23, 23);
  const min = clampInt(m[2], 0, 59, 0);
  return { h, min };
}

/** 距下一次 diaryTime 的毫秒数（过了今天就等明天的那一拍）。 */
function msUntilNext(diaryTime, fromMs) {
  const { h, min } = parseDiaryTime(diaryTime);
  const from = new Date(Number.isFinite(fromMs) ? fromMs : now());
  const target = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, min, 0, 0);
  if (target.getTime() <= from.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - from.getTime();
}
