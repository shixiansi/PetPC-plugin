// lib/core.js —— 文档骨架与宿主桥
//
// 信封与 diary-writer / calendar 同型：`{v, type, id, method, payload}`，宿主拒绝时 reject 的
// 就是它那句中文（"未获权限 storage" 这类），**原样显示**，不要包成"操作失败"。
//
// 一个文档、三副面孔，由 init.surface 决定（`kind` 与 `slot` 要一起看：浮层面的 kind 是
// 'surface' 而**没有** slot，常驻帧的 kind 是 'panel'、slot 是 'background'）：
//
//   surface     桌宠旁边那块 280×112 的卡片：三条"还剩几分钟" + 「今天先别提醒我」。
//   background  桌宠的常驻无名帧：跑钟、说话、推徽标。界面关掉之后提醒还得继续，靠它。
//   workshop    控制中心插件页：只读的一屏（下一次、今天的次数、免打扰那一段、能力缺什么）。
//
// 键只有两个，写者各一个（手册 §6.3"一个键只有一个写者"）：
//
//   state/v1    谁在跑钟谁写它（同一时刻只有一个，见 app.js 的 isTicker）。
//   pause/today 「今天先别提醒我」写的是**日期**本身，所以它天然会在第二天失效，
//               不需要有人来清它——清它的那一行代码就是多一个能忘掉的地方。

'use strict';

const PROTOCOL = 1;

/** 私有存储的两个键。**没有扩展名**：键不是文件名，带 `.json` 会被宿主整条拒绝。 */
const STATE_KEY = 'state/v1';
const PAUSE_KEY = 'pause/today';

let nextRequestID = 1;
const pending = new Map();

const granted = new Set();
/** init.host.methods：这个窗口真正服务的方法表。有它就别背"哪个宿主有什么"那张表。 */
let hostMethods = null;
let selfId = '';
/** 'boot' | 'surface' | 'workshop' | 'background' */
let view = 'boot';

/** config.get 的原文（全是字符串，形状由 normalizeConfig 收）。定时器里只读这一份内存副本。 */
let cfg = {};
/** 今天的状态：跨日、到点、次数都在这里；由 schedule.js 的 step 纯函数推出来。 */
let state = emptyState();
/** 「今天先别提醒我」写下的那一天（date 串）；不是今天就不算。 */
let pauseDay = '';

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage(Object.assign({ v: PROTOCOL }, message), '*');
}

function request(method, payload) {
  const id = String(nextRequestID++);
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** 这个窗口服务不服务某个方法：先问 init.host，老宿主退回 slot（手册 §9）。 */
function serves(method) {
  if (hostMethods) return hostMethods.includes(method);
  return view !== 'workshop';
}

function can(permission) {
  return granted.has(permission);
}

// --- DOM ---------------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

const els = {
  body: document.body,
  boot: el('boot-note'),
  surface: el('surface'),
  pause: el('sf-pause'),
  workshop: el('workshop'),
  wsState: el('ws-state'),
  wsQuiet: el('ws-quiet'),
  wsCounts: el('ws-counts'),
  wsNoteSub: el('ws-note-sub'),
  status: el('status'),
  rows: {
    sit: el('row-sit'),
    water: el('row-water'),
    eye: el('row-eye'),
  },
  wsRows: {
    sit: el('ws-row-sit'),
    water: el('ws-row-water'),
    eye: el('ws-row-eye'),
  },
};

function show(node, visible) {
  if (!node) return;
  node.classList.toggle('hidden', !visible);
}

function textOf(node, value) {
  if (!node) return;
  node.textContent = value === undefined || value === null ? '' : String(value);
}

/** 整页都按当前的面孔重画。background 面没有像素：它那一面关心的是"下一拍会不会说话"。 */
function paint() {
  if (view === 'surface') paintSurface();
  else if (view === 'workshop') paintWorkshop();
}

function showView() {
  if (els.body) els.body.dataset.view = view;
  show(els.surface, view === 'surface');
  show(els.workshop, view === 'workshop');
  show(els.boot, view !== 'surface' && view !== 'workshop' && view !== 'background');
}

/** init.surface 的三副面孔。kind 与 slot 一起看：surface 的 kind='surface' 而没有 slot。 */
function viewOf(surface) {
  const info = surface || {};
  const kind = String(info.kind || 'panel');
  const slot = String(info.slot || '');
  if (slot === 'workshop') return 'workshop';
  if (slot === 'background') return 'background';
  if (kind === 'surface' || slot === 'surface') return 'surface';
  // 认不出来的挂载按"一页"处理：有页面总比白屏好，而且它不是桌宠那一侧，不会去弹气泡。
  return 'workshop';
}

// --- 私有数据 ------------------------------------------------------------------

/** 用户在宿主的设置表单里改完，帧不会重挂，所以读不到新值就沿用上一份（一次失败不该让钟停摆）。 */
async function refreshConfig() {
  if (!can('plugin.config')) return false;
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
    return true;
  } catch {
    return false;
  }
}

async function refreshState() {
  if (!can('storage')) return false;
  try {
    const out = await request('storage.get', { key: STATE_KEY });
    state = normalizeState(out && out.value);
    return true;
  } catch {
    return false;
  }
}

async function writeState() {
  if (!can('storage')) return false;
  try {
    await request('storage.set', { key: STATE_KEY, value: JSON.stringify(state) });
    return true;
  } catch {
    return false;
  }
}

async function refreshPause() {
  if (!can('storage')) return false;
  try {
    const out = await request('storage.get', { key: PAUSE_KEY });
    pauseDay = String((out && out.value) || '');
    return true;
  } catch {
    return false;
  }
}

async function writePause(day) {
  if (!can('storage')) return false;
  try {
    await request('storage.set', { key: PAUSE_KEY, value: day });
    pauseDay = day;
    return true;
  } catch {
    return false;
  }
}

function configOf() {
  return normalizeConfig(cfg);
}

/** 今天是不是被"今天先别提醒我"停掉了。日期串不等就是没停（新的一天自动恢复）。 */
function pausedAt(now) {
  return Boolean(pauseDay) && pauseDay === dayKey(now);
}

// --- 小工具 -------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 宿主的 error 已经是一句中文，直接显示（手册 §5.3 第 5 条）。 */
function errorText(err) {
  return String((err && err.message) || err || '未知原因');
}

function say(line) {
  textOf(els.status, line || '');
  // 那张卡片只有 112px 高，放不下一行错误；把它挂到卡片自己的 title 上（悬停可见），
  // 既没占版面，也没有把话咽回去。
  if (els.surface && line) els.surface.title = line;
}

function minutesOf(ms) {
  return Math.max(1, Math.ceil((Number(ms) || 0) / 60000));
}

// 首帧的配色：控制中心把 ?theme= 放在帧地址上；桌宠没有这个参数，默认深色。
applyTheme(new URLSearchParams(location.search).get('theme'));
