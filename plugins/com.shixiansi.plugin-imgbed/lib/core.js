// lib/core.js —— 文档骨架与宿主桥
//
// 经典 script，与同目录其它文件共享一个全局作用域；加载顺序写在 panel.html 里。
// 信封与 memcore / websearch 同型：{v, type, id, method, payload}，宿主拒绝时 reject 的是
// 宿主那句中文，原样显示给用户。
//
// 两副面孔（由 init.surface.slot 决定，不猜）：
//
//   background   桌宠挂的常驻帧。什么都不画，只负责答 plugin.call 的 upload。
//   workshop     控制中心插件页。上传的真实界面都在这一面。
//
// 为什么上传界面在控制中心而不是宠物旁边：桌宠的右键菜单只有三格（日程 / 对话 / 番茄钟），
// 那三格由 panelSlot 声明，新插件没有格子里可去；而"拖一张图进来、拿走一条链接"是一屏
// 需要宽度的活，正好是控制中心插件页的形状。

'use strict';

// --- DOM ---------------------------------------------------------------------
//
// 常驻帧里这些元素全都不存在，每个都按可选访问。

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  chipHost: document.getElementById('chip-host'),
  chipState: document.getElementById('chip-state'),
  drop: document.getElementById('drop'),
  pick: document.getElementById('pick'),
  pickBtn: document.getElementById('pick-btn'),
  queue: document.getElementById('queue'),
  queueEmpty: document.getElementById('queue-empty'),
  historyBody: document.getElementById('history-body'),
  historyEmpty: document.getElementById('history-empty'),
  historyClear: document.getElementById('history-clear'),
  status: document.getElementById('status'),
};

// --- the bridge --------------------------------------------------------------

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map();

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

function request(method, payload) {
  const id = String(nextRequestID++);
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** 一次 plugin.call 的回包。ticket 原样带回——带错了宿主不认，调用方只会等到超时。 */
function postCallResult(ticket, ok, value) {
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

// --- state -------------------------------------------------------------------

const granted = new Set();
let self = { pluginId: '', slot: '', program: '' };
// init.host.methods 是这个窗口真正服务的方法表。有它就别背"哪个宿主有什么"那张表。
let hostMethods = null;

// --- capability questions -----------------------------------------------------

/**
 * 这个窗口服务不服务某个方法。
 *
 * 优先问 init.host（宿主自己算出来的表，和闸门是同一个答案）；没有这个字段的老宿主退回
 * surface.slot。**永远不要**先发出去、被拒了再兜底：那正是日志里 571 行"本程序不支持该方法"
 * 的来源，而插件的 catch 只让界面好看，不让日志安静。
 */
function serves(method) {
  if (hostMethods) return hostMethods.includes(method);
  // 老宿主：控制中心那一面没有 net.fetch 之外的网络能力；这里用到的只有 net.fetch，
  // 而它是两个宿主都服务的，所以只要不是 workshop 就当有。
  return true;
}

// --- config / storage --------------------------------------------------------

let cfg = {};

/**
 * 重读设置。每次上传、每次重画读一遍最新的：用户在控制中心的设置页改完，插件的帧不会重挂。
 */
async function refreshConfig() {
  if (!granted.has('plugin.config')) {
    cfg = {};
    return;
  }
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 读不到就沿用上一次：一次 config.get 失败不该让上传停摆。
  }
}

async function readJSON(key, fallback) {
  // 没有 storage 权限就连问都不问（自检里一次被拒的请求就是一条 ungranted-request）。
  if (!granted.has('storage')) return fallback;
  try {
    const out = await request('storage.get', { key });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

async function writeJSON(key, value) {
  await request('storage.set', { key, value: JSON.stringify(value) });
}

// --- helpers -----------------------------------------------------------------

function now() {
  return Date.now();
}

function text(value, max) {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const limit = Number.isFinite(max) && max > 0 ? max : 2000;
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function num(key, min, max, fallback) {
  return clampInt(cfg[key], min, max, fallback);
}

function say(line) {
  if (els.status) els.status.textContent = line || '';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

/**
 * 把一段文字放进剪贴板，返回是否成功。
 *
 * 帧是 opaque origin，`navigator.clipboard` 需要宿主的 iframe 带 clipboard-write 的 allow
 * （宿主没带，那会让每一次复制都变成一次权限提示），所以退到 `execCommand('copy')`——它只需要
 * 一次用户手势，而我们本来就在点击的处理器里。**失败了也不报错**：调用方把链接原样显示出来，
 * 用户自己选中复制。宁可多一步，也不要一个"复制成功"的谎话。
 */
function copyText(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) return false;
  try {
    const area = document.createElement('textarea');
    area.value = text;
    // 放在可视区外，但必须能被选中：display:none 的元素选不了。
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
