// lib/core.js —— 文档骨架与宿主桥。
//
// 一个文档，三副面孔（由 init 的 surface 决定，不猜）：
//
//   page   控制中心的插件页（slot: workshop）：管习惯（增删）、看今天与统计。
//   card   宠物旁边那块浮层面（kind: surface）：280×140 的紧凑卡片，点一下就打卡。
//   bg     桌宠的常驻无名帧（slot: background）：不画东西。**头顶那行字只有它推**，
//          到点提醒的钟表定时器也只有它跑。
//
// 三副面孔各自是**独立的文档**（三个 iframe，没有共享内存），唯一共享的是 storage 里那一个键
// 与宿主的消息。所以"谁写哪一格"必须明确：见 lib/store.js 顶部。

'use strict';

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map();

const els = {
  root: document.getElementById('root'),
  card: document.getElementById('card'),
  cardStreak: document.getElementById('card-streak'),
  cardMeta: document.getElementById('card-meta'),
  cardList: document.getElementById('card-list'),
  cardNote: document.getElementById('card-note'),
  page: document.getElementById('page'),
  pageStatus: document.getElementById('page-status'),
  statStreak: document.getElementById('stat-streak'),
  statBest: document.getElementById('stat-best'),
  statPending: document.getElementById('stat-pending'),
  todayList: document.getElementById('today-list'),
  todayEmpty: document.getElementById('today-empty'),
  addForm: document.getElementById('add-form'),
  addName: document.getElementById('add-name'),
  habitList: document.getElementById('habit-list'),
  habitsEmpty: document.getElementById('habits-empty'),
  badgeNote: document.getElementById('badge-note'),
  remindNote: document.getElementById('remind-note'),
};

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

function request(method, payload) {
  const id = String(nextRequestID++);
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return promise;
}

/** 一次 plugin.call 的回包。ticket 必须原样带回——带错了宿主不认，调用方只会等到超时。 */
function postCallResult(ticket, ok, value) {
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

// --- 我在这三个身份里的哪一个 ------------------------------------------------

let role = ''; // 'page' | 'card' | 'bg'
let pluginId = '';
// init.host.methods 是这个窗口真正服务的方法表；有它就别背"哪个宿主有什么"那张表。
let hostMethods = null;
const granted = new Set();

/**
 * 这个窗口服务不服务某个方法。
 *
 * 优先问 init.host（宿主自己算出来的表，与闸门是同一个答案）；没有这个字段的老宿主退回
 * 「控制中心那一面就是 workshop」。**绝不先发出去再兜底**：那正是日志里几百行
 * 「本程序不支持该方法」的来源，而 catch 只让界面好看，不让日志安静。
 */
function serves(method) {
  if (hostMethods) return hostMethods.includes(method);
  return role !== 'page';
}

/**
 * 头顶那行字与浮层面能不能用。
 *
 * 两个条件都要：用户授予了 pet.surface（`pet.badge` 借的就是这份授权），**并且**这个窗口
 * 服务 pet.badge（控制中心的插件页没有宠物）。缺任何一个都不发请求——未授权时一个
 * pet.badge 请求都不发，界面改为说清楚缺的是哪一项。
 */
function canPet() {
  return granted.has('pet.surface') && serves('pet.badge');
}

// --- 设置 --------------------------------------------------------------------

/**
 * 设置项的兜底值。
 *
 * 复制自 manifest 的 config 默认值：`config.get` 读不到（没授权、或用户清空了某项）时界面
 * 还要能画出"默认是 20:00 / 按连续天数显示"，而不是一行空白。
 */
const DEFAULT_CONFIG = { remindAt: '20:00', badgeMode: 'streak', remindEnabled: 'true' };
let cfg = Object.assign({}, DEFAULT_CONFIG);

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  try {
    const out = await request('config.get', {});
    const values = (out && out.values) || {};
    cfg = Object.assign({}, DEFAULT_CONFIG, values);
  } catch {
    // 读不到就沿用上一次：一次 config.get 失败不该让打卡停摆。
  }
}

/** bool 型设置到手的是字符串 `"true"`（宿主就是这么存的），所以不能写 `=== true`。 */
function configOn(value) {
  const s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  return !(s === '' || s === 'false' || s === '0' || s === 'no' || s === 'off');
}

// --- 小工具 ------------------------------------------------------------------

function nowMs() {
  return Date.now();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

/** 只往插件页写状态行；卡片里没有那一行，常驻帧也不该画东西。 */
function say(line) {
  if (role === 'page' && els.pageStatus) els.pageStatus.textContent = line || '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
