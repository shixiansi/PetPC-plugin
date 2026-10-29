// lib/compact.js —— 定时记忆压缩：每天凌晨把当天的 L1/L2 压成一段 L3 长期摘要
//
// WHY 需要这一层：L1 是滚动缓冲（8 轮），L2 是会话摘要（500 字），它们都在"最近"的
// 尺度上工作。一个月后，"这个月初他吵了一架、后来和好了"这样的故事线在 L1/L2 里已经
// 没有了——情节（L3）只留了散点事实，丢的是**叙事**。压缩就是每天凌晨把前一天的
// L1 原文 + L2 摘要压成一段 ≤200 字的 L3 长期摘要，按天存档、可回放。
//
// 数据形状（全部在本插件私有目录）：
//
//   mem/role/<会话>/l3          [{at, day, text}]   L3 每日长期摘要（上限 l3Max 条，丢最旧）
//   state/compact               {lastDay, lastAt}   上次跑到的日期（跳过已压缩的天）
//
// 触发（三道，互相独立，都幂等）：
//
//   1. 定时：常驻帧里每分钟看一次钟，本地日期一变（凌晨 00:00 过后第一跳）就跑；
//   2. 兜底：常驻帧刚启动时跑一次——宿主半夜重启导致定时跳过的话，启动补上；
//   3. 手动：plugin.call compact {day?} ——工坊页与测试用。
//
// 幂等：state/compact.lastDay 记"已经压到哪一天"；同一天重复触发直接跳过。
// 连贯性：压缩的输入是 L1 的当天往来 + 当前 L2 摘要 + 已有的最后一段 L3——模型看到的
// 是连续的故事，而不是孤立的 24 小时。
//
// WHY 200 字：L3 是"每天一段"，一段 200 字×40 条 = 8K 字符，恰好是 prompt 预算里
// "值得长期记住的事"那一档的尺寸；也更贵——它一天每会话只花一次请求。

'use strict';

const MEM_L3 = 'l3';
const COMPACT_STATE = 'state/compact';

/** L3 每日摘要的单条上限（任务书：≤200 字）。 */
const L3_TEXT_MAX = 200;
/** L3 存档条数上限（与 episodes 的 episodeMax 同一量级）。 */
const L3_MAX = 60;

function l3Path(roleKey) {
  return rolePath(roleKey, MEM_L3);
}

/** 本地时区的 YYYY-MM-DD（与 today() 同型，但可传入 Date）。 */
function dayKeyOf(date) {
  const d = date instanceof Date ? date : new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** 上一个自然日（本地时区）。 */
function previousDayKey(nowMs) {
  const d = new Date(Number(nowMs) || now());
  d.setDate(d.getDate() - 1);
  return dayKeyOf(d);
}

/** 一段往来属于哪一天（按本地时区，以 user 那一轮的 at 为准）。 */
function dayOfTurn(turn) {
  const at = Number(turn && turn.at) || 0;
  return at ? dayKeyOf(new Date(at)) : '';
}

/**
 * 从一段模型输出里取出 L3 摘要文本。
 *
 * 期望形状 {"summary":"…"}；解析不出来就把整段当摘要——一次失败的压缩不该让当天
 * 的故事丢掉。返回 '' = 模型什么都没给。
 *
 * 截断自己动手而不是用 text()：text(max) 的产物最长是 max+1（切到 max 再补一个 …），
 * 而"200 字以内"是硬承诺——超了先切到 L3_TEXT_MAX-1，省略号补在最后，总长 ≤200。
 */
function parseL3(raw) {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (!body) return '';
  const parsed = parseObject(body);
  const summary = (parsed && typeof parsed.summary === 'string' ? parsed.summary : body).trim();
  if (summary.length <= L3_TEXT_MAX) return summary;
  return `${summary.slice(0, L3_TEXT_MAX - 1)}…`;
}

/**
 * 挑出"某一天"的往来（L1 里 at 落在 day 的那些轮）。
 * L1 只留最近 8 轮，所以凌晨跑的时候当天的原文大概率还在——这正是把触发放在凌晨的原因。
 */
function turnsOf(turns, day) {
  return (Array.isArray(turns) ? turns : []).filter((t) => dayOfTurn(t) === day);
}

/**
 * 组一次压缩请求的 prompt。输入三样：当天的往来、当前 L2 摘要、已有的最后一段 L3。
 * 返回 {system, text}；没有可压缩的材料返回 null（调用方跳过这一次）。
 */
function compactPrompt(turns, day, summary, lastL3) {
  const material = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && typeof t.text === 'string' && t.text !== '')
    .map((t) => `${t.role === 'assistant' ? '你' : t.who || '对方'}：${text(t.text, 160)}`)
    .join('\n');

  if (!material && !(summary && summary.text)) return null;

  const system = [
    '你在整理一份长期记忆，供以后回答时回顾。只输出 JSON，不要解释。',
    '形状：{"summary":"…"}',
    `summary 是一段不超过 ${L3_TEXT_MAX} 字的长期摘要：这一天发生了什么、谁说了什么要紧的话、`,
    '情绪怎么流转、有什么没说完的事。写成一段连贯的叙事，不要列清单、不要标题。',
    lastL3 ? '上一段长期摘要在下面，接住它的故事线，不要重复它已经写清的部分。' : '',
  ].filter(Boolean).join('\n');

  const parts = [
    lastL3 ? `上一段长期摘要：${lastL3}` : '',
    summary && summary.text ? `这个会话目前的摘要：${summary.text}` : '',
    material ? `这一天的往来：\n${material}` : '',
    '请给出这一天的长期摘要。',
  ].filter(Boolean);

  if (!parts.length) return null;
  return { system, text: parts.join('\n\n') };
}

/** 读一个会话的 L3 存档（没有就是空数组）。 */
async function loadL3(roleKey) {
  const arr = await readJSON(l3Path(roleKey), []);
  return Array.isArray(arr) ? arr.filter((e) => e && typeof e.text === 'string') : [];
}

async function saveL3(roleKey, entries) {
  await writeJSON(l3Path(roleKey), entries.slice(-L3_MAX));
}

/** 读压缩状态（没有就是 {lastDay:'', lastAt:0}）。 */
async function loadCompactState() {
  const s = await readJSON(COMPACT_STATE, null);
  return s && typeof s === 'object' ? { lastDay: String(s.lastDay || ''), lastAt: Number(s.lastAt) || 0 } : { lastDay: '', lastAt: 0 };
}

async function saveCompactState(state) {
  await writeJSON(COMPACT_STATE, state);
}

/**
 * 压缩一个会话的某一天。返回 {ok, skipped, reason?}：
 *   skipped=true 且 reason='no-material'  当天没有往来、L2 也为空
 *   skipped=true 且 reason='no-request'   材料有，但模型没给内容（摘要落空）
 *
 * WHY 返回结构而不是抛错：批量压缩多个会话时，一个会话没材料不是失败，
 * 是常态（大多数会话大多数天没有往来）。
 */
async function compactRoleDay(roleKey, day) {
  const state = await loadRole(roleKey);
  const turns = turnsOf(state.turns, day);

  // L1 里已经挤出去的部分拿不回来了——这是"凌晨跑"的全部意义：赶在 L1 滚掉之前。
  // 但如果用户好几天没开桌宠，L1 里只剩最近 8 轮：那就压"手头有的"，并且 L2 摘要
  // 兜底（它是跨天的）。
  const l3 = await loadL3(roleKey);
  const lastL3 = l3.length ? l3[l3.length - 1].text : '';

  const prompt = compactPrompt(turns, day, state.summary, lastL3);
  if (!prompt) return { ok: false, skipped: true, reason: 'no-material' };

  let raw = '';
  try {
    raw = await askModel(prompt);
  } catch (err) {
    await noteError('compact', err);
    return { ok: false, skipped: false, reason: String(err && err.message ? err.message : err) };
  }
  const summary = parseL3(raw);
  if (!summary) return { ok: false, skipped: true, reason: 'no-request' };

  const existing = l3.filter((e) => e.day !== day);
  existing.push({ at: now(), day, text: summary });
  await saveL3(roleKey, existing);
  await appendChains(roleKey, { at: now(), roleId: roleKey, kind: 'l3', who: 'bot', text: `压缩了 ${day} 的记忆` });
  return { ok: true, skipped: false, text: summary };
}

/**
 * 跑一次"把到昨天为止还没压的天都压掉"。
 *
 * day 参数（可选）显式指定要压哪一天——工坊页"补压某天"与测试的逐日重放用它；
 * 不带 day 时按 lastDay+1 → 昨天 的区间走（定时触发的默认路径）。
 * lastDay 只在"走到昨天"的路径上推进；显式 day 不改 lastDay（它是补录，不是推进）。
 *
 * 列会话走 storage.list（mem/role 下的真实目录），而不是自己猜键名。
 * 返回 {days: [{day, roleKey, ok, skipped, reason}], lastDay}。
 */
async function compactDue(daysBack = 1, day = '') {
  const state = await loadCompactState();
  const due = [];
  const explicit = Boolean(day);
  if (explicit) {
    // 显式补录：只压指定的那一天（lastDay 不动）。
    due.push(day);
  } else {
    const start = new Date();
    start.setDate(start.getDate() - Math.max(1, Number(daysBack) || 1));
    // 从"上次压到的那天的后一天"（或 daysBack 天前）走到昨天。
    const from = state.lastDay
      ? (() => { const d = new Date(`${state.lastDay}T00:00:00`); d.setDate(d.getDate() + 1); return d; })()
      : start;
    const cursor = new Date(Math.max(from.getTime(), start.getTime()));
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    while (dayKeyOf(cursor) <= dayKeyOf(yesterday)) {
      due.push(dayKeyOf(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    if (!due.length) return { days: [], lastDay: state.lastDay };
  }

  const roleKeys = await listRoleKeys();
  const results = [];
  for (const one of due) {
    for (const roleKey of roleKeys) {
      const out = await compactRoleDay(roleKey, one);
      results.push({ day: one, roleKey, ...out });
    }
  }
  if (!due.length) return { days: [], lastDay: state.lastDay };
  const lastDay = explicit ? state.lastDay : due[due.length - 1];
  if (!explicit) await saveCompactState({ lastDay, lastAt: now() });
  return { days: results, lastDay };
}

/**
 * 定时触发的 tick：本地日期一变就跑。
 * 返回 true = 触发了一次压缩。
 */
async function compactTick() {
  const state = await loadCompactState();
  const yesterday = previousDayKey(now());
  if (state.lastDay === yesterday || state.lastDay > yesterday) return false;
  await compactDue(1);
  return true;
}

/** 定时器本体：每分钟看一次钟。挂载由 app.js 在 background 帧里做。 */
function startCompactTimer() {
  if (compactTimer) return compactTimer;
  compactTimer = setInterval(() => {
    void compactTick().catch(() => {});
  }, 60 * 1000);
  // 启动补跑：宿主半夜重启导致定时跳过的话，这里补上（幂等，重复跑会跳过）。
  setTimeout(() => { void compactTick().catch(() => {}); }, 15 * 1000);
  return compactTimer;
}

function stopCompactTimer() {
  if (compactTimer) clearInterval(compactTimer);
  compactTimer = null;
}

let compactTimer = null;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MEM_L3, COMPACT_STATE, L3_TEXT_MAX, L3_MAX,
    dayKeyOf, previousDayKey, dayOfTurn, parseL3, turnsOf, compactPrompt,
  };
}
