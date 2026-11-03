// lib/core.js —— 文档骨架与宿主桥
//
// 经典 script，与同目录其它文件共享一个全局作用域（加载顺序写在 panel.html 里）。信封与
// calendar / imgbed 同型：{v, type, id, method, payload}；宿主拒绝时 reject 的是它那句中文，
// 原样显示给用户，不要包成"操作失败"。三种面孔由 init.surface 决定（`kind` 与 `slot` 要看一起：
// 浮层面的 kind 是 'surface' 而**没有 slot**，常驻帧的 kind 是 'panel'、slot 是 'background'）。
//
// 谁写哪份数据：**清单只有两个写者，而且不重叠**——workshop 面写清单，background 面写
// `anniversary/seen`（当天说过的记号），浮层面只读。手册 6.3 那条"一个键只有一个写者"就是这么
// 落地的：background 永远不写清单，workshop 永远不写 seen。

'use strict';

const PROTOCOL = 1;
let nextRequestId = 1;
const pending = new Map();

// 清单本体与"当天说过话"的记号。键是相对路径（≤4 段、每段扁平名、不带扩展名）。
const KEY_LIST = 'anniversary/list';
const KEY_SEEN = 'anniversary/seen';

const granted = new Set();
const mountInfo = { kind: 'panel', slot: '', rect: null, rectIndex: 0, rectCount: 1 };
// init.host.methods 是这个窗口真正服务的方法表。有它就别背"哪个宿主有什么"那张表。
let hostMethods = null;

// config.get 的最近一份。定时器与重算都只读这份内存副本。
const cfg = {};
// 一份视图状态：清单、今天算出来的模型、读盘失败的原因。
const state = { list: [], agenda: null, error: '' };

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

function request(method, payload) {
  const id = String(nextRequestId++);
  // 先把 pending 装上再发：宿主（或测试里的假宿主）可能在 postMessage 里同步回包，那时 pending 里
  // 还没有这个 id，回包会被当成"过期的 id"丢掉——表现是等一个永远不来的答复。
  const answer = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return answer;
}

/** 一次 plugin.call 的回包。ticket 原样带回——带错了宿主不认，调用方只会等到超时。 */
function postCallResult(ticket, ok, value) {
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

/**
 * 这个窗口服务不服务某个方法：优先问 init.host（宿主自己算的表，和闸门是同一个答案），没有这个
 * 字段的老宿主退回 surface.slot。**不要**先发出去、被拒了再兜底——那正是日志里几百行"本程序不
 * 支持该方法"的来源（手册 §9）。
 */
function serves(method) {
  if (hostMethods) return hostMethods.includes(method);
  return mountInfo.slot !== 'workshop';
}

function can(permission) {
  return granted.has(permission);
}

// --- DOM ---------------------------------------------------------------------

const byId = (name) => document.getElementById(name);
const els = {
  body: document.body, boot: byId('boot-note'), surfaceCard: byId('surface'),
  sfCount: byId('sf-count'), sfRows: byId('sf-rows'), sfEmpty: byId('sf-empty'), sfClose: byId('sf-close'),
  workshop: byId('workshop'), wsState: byId('ws-state'), wsList: byId('ws-list'), wsEmpty: byId('ws-empty'),
  wsBad: byId('ws-bad'), wsName: byId('ws-name'), wsDate: byId('ws-date'), wsYearly: byId('ws-yearly'),
  wsAdd: byId('ws-add'), wsStatus: byId('ws-status'),
};

/** 显隐。**只管这一层**：藏之前先确认要藏的是控件还是容器（手册 §8.2b 的第二次翻车）。 */
function show(node, visible) {
  if (node) node.classList.toggle('hidden', !visible);
}

function textOf(node, value) {
  if (node) node.textContent = value === undefined || value === null ? '' : String(value);
}

/**
 * 我是不是浮层面的那一块。
 *
 * **用 kind 判断，不要用 slot。** 浮层面的 `kind` 是 `'surface'`，而 `slot` 只在宿主"手里有
 * 一个槽名"时才出现——它可能是一个面板槽名（右键菜单那一格，例如 `pomodoro`），也可能压根
 * 没有（手册 §5.2）。这里原来判的是 `mountInfo.slot === 'surface'`：在"宿主没给 slot"的形状下
 * 恰好成立，一旦宿主带着槽名过来，卡片就整个不显示——矩形声明了、窗口区域也裁出来了，里面是
 * 一块空白。2026-11-03 的截图阶段抓到的就是这一条（jsdom 那套用例没抓到，因为它们的假 init 里
 * 多带了一个 `slot: 'surface'`，而那正是真宿主不会发的值）。
 */
function isSurfaceMount() { return mountInfo.kind === 'surface'; }

/** 按当前这一面重画。常驻帧没有像素，它的事在 app.js 的 backgroundRefresh 里。 */
function paint() {
  if (mountInfo.slot === 'workshop') paintWorkshop();
  else if (isSurfaceMount()) paintCard();
}

// --- 小工具 -------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function cfgText(key, fallback) {
  const raw = cfg[key];
  if (raw === undefined || raw === null) return fallback === undefined ? '' : fallback;
  return String(raw);
}

function cfgNum(key, min, max, fallback) {
  return clampInt(cfgText(key, ''), min, max, fallback);
}

function cfgBool(key, fallback) {
  const raw = cfgText(key, '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 给页面上的失败文案：宿主的 error 已经是一句中文，不要再包成"操作失败"。 */
function errorText(err) {
  return String((err && err.message) || err || '未知原因');
}

// 首帧的配色：控制中心把 ?theme= 放在帧地址上，桌宠没有这个参数（它永远是深色）。
applyTheme(new URLSearchParams(location.search).get('theme'));

// --- 读盘 ---------------------------------------------------------------------

/**
 * 重读设置。用户在宿主的设置表单里改完，插件的帧不会重挂；而本插件没有 `events` 授权，收不到
 * config.changed，所以每次重算都自己读一遍（一次 config.get 是 DEBUG 级的一行）。
 */
async function refreshConfig() {
  if (!can('plugin.config')) return;
  try {
    const out = await request('config.get', {});
    Object.assign(cfg, (out && out.values) || {});
  } catch {
    // 读不到就沿用上一份：一次 config.get 失败不该让整屏停摆。
  }
}

async function readKey(key, fallback) {
  // 没有 storage 权限就连问都不问（一次被拒的请求就是一条 ungranted-request）。
  if (!can('storage')) return fallback;
  try {
    const out = await request('storage.get', { key });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    return raw === '' ? fallback : raw;
  } catch {
    return fallback;
  }
}

async function writeKey(key, value) {
  if (!can('storage')) return false;
  try {
    await request('storage.set', { key, value: String(value) });
    return true;
  } catch {
    return false;
  }
}

/**
 * 清单 + 今天 → state。**读失败要留痕**：宿主拒绝时界面不能装作"你还没有纪念日"——那是把一次
 * 失败说成一件事实。
 */
async function refreshData() {
  await refreshConfig();
  state.error = '';
  state.list = [];
  if (!can('storage')) {
    state.agenda = Agenda.build([], Dates.todayISO(new Date()));
    return state.agenda;
  }
  try {
    const out = await request('storage.get', { key: KEY_LIST });
    state.list = Agenda.parseList(out && typeof out.value === 'string' ? out.value : '');
  } catch (err) {
    state.error = errorText(err);
    state.list = [];
  }
  state.agenda = Agenda.build(state.list, Dates.todayISO(new Date()));
  return state.agenda;
}
