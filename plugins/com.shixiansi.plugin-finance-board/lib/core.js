// lib/core.js —— 文档骨架：协议信封、设置、私有存储、三个面共用的格式化
//
// 经典 script，与同目录其它文件共享一个全局作用域（加载顺序写在 panel.html 里）。信封与
// anniversary / imgbed 同型；宿主拒绝时 reject 的是它那句中文，原样显示，不要包成"操作失败"。
// 三副面孔由 init 决定（`kind` 与 `slot` 要一起看：浮层面的 kind 是 'surface'、**没有** slot）：
// workshop 是控制中心那一页，surface 是宠物旁边那块 300×150 的卡片，别的落点本插件没声明。
'use strict';

const PROTOCOL = 1;
let nextRequestId = 1;
const pending = new Map();
// 两个私有键（相对路径、每段扁平名、**不带扩展名**——带了扩展名宿主整个请求都不执行）。
//   market/snapshot  上一次成功取到的那一份，是**缓存**不是用户数据：哪个面先刷到就由谁写。
//   market/view      浏览偏好（周期）。只由插件页写，卡片只读。
const KEY_SNAPSHOT = 'market/snapshot';
const KEY_VIEW = 'market/view';

const granted = new Set();
const mountInfo = { kind: 'panel', slot: '', rect: null, rectIndex: 0, rectCount: 1 };
// init.host.methods 是这个窗口真正服务的方法表。有它就别背"哪个宿主有什么"那张表。
let hostMethods = null;
const cfg = {};

// 时钟：所有"现在几点""隔了多久"都走 nowMs()，用例才能把"周六"喂进来——休市判定要是只能靠
// 真实日期，那条规则就永远测不到。
let clockFn = () => Date.now();
function nowMs() {
  return Number(clockFn()) || Date.now();
}

function setClock(fn) {
  clockFn = typeof fn === 'function' ? fn : () => Date.now();
}

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

function request(method, payload) {
  const id = String(nextRequestId++);
  // 先把 pending 装上再发：宿主可能同步回包，那时 pending 里还没有这个 id，回包会被当成
  // "过期的 id"丢掉——表现是等一个永远不来的答复。
  const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return answer;
}

/** 优先问 init.host（宿主自己算的表，和闸门同一个答案），老宿主退回 slot。别先发再兜底。 */
function serves(method) {
  if (hostMethods) return hostMethods.includes(method);
  return mountInfo.slot !== 'workshop';
}

function can(permission) {
  return granted.has(permission);
}

const byId = (id) => document.getElementById(id);

const els = {
  body: document.body, boot: byId('boot-note'), surfaceCard: byId('surface'),
  sfSrc: byId('sf-src'), sfRows: byId('sf-rows'), sfFoot: byId('sf-foot'), sfClose: byId('sf-close'),
  workshop: byId('workshop'), wsState: byId('ws-state'), wsRows: byId('ws-list'),
  wsEmpty: byId('ws-empty'), wsBad: byId('ws-bad'), wsRefresh: byId('ws-refresh'),
  wsTargets: byId('ws-targets'), wsSave: byId('ws-save'), wsStatus: byId('ws-status'),
};

/**
 * 我是不是那块浮层面。**只能看 `kind`**：`slot` 只在宿主手里有槽名时才出现（手册 §5.2），一块被
 * 面板槽（比如 `pomodoro`）打开的浮层面拿到的是那个槽名，`slot` 永远不等于 'surface'。第一版就是
 * 这么判的：矩形裁出来了、卡片还停在 `.hidden` 里，屏幕上什么都没有。
 */
function isSurfaceMount() {
  return mountInfo.kind === 'surface';
}

/** 显隐。**只管这一层**：藏之前先确认要藏的是控件还是容器（手册 §8.2b 的第二次翻车）。 */
function show(node, visible) {
  if (node) node.classList.toggle('hidden', !visible);
}

function textOf(node, value) {
  if (node) node.textContent = value === undefined || value === null ? '' : String(value);
}

/** 按当前这一面重画。没声明的那两种落点只刷新、不画——它们没有像素。 */
function paint() {
  if (mountInfo.slot === 'workshop') paintWorkshop();
  else if (isSurfaceMount()) paintCard();
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value).trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function cfgText(key, fallback) {
  const raw = cfg[key];
  if (raw === undefined || raw === null) return fallback === undefined ? '' : fallback;
  return String(raw);
}

function cfgNum(key, min, max, fallback) {
  return clampInt(cfgText(key, ''), min, max, fallback);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 给页面上的失败文案：宿主的 error 已经是一句中文，不要再包成"操作失败"。 */
function errorText(err) {
  return String((err && err.message) || err || '未知原因');
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// 两条数字格式的硬要求：涨跌永远带正负号与两位小数；**没有数据写「—」，不写 0**——0 是一个
// 价格，「—」才是"没有"，写成 0 用户会以为那只股票跌到零了。
function fmtPrice(value) {
  const n = numberOrNull(value);
  if (n === null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1) return n.toFixed(2);
  return abs >= 0.01 ? n.toFixed(4) : n.toPrecision(4);
}

function fmtChange(value) {
  const n = numberOrNull(value);
  return n === null ? '—' : (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2) + '%';
}

/** 涨 / 跌 / 平，给 CSS 用。 */
function changeSide(value) {
  const n = numberOrNull(value);
  if (n === null || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

/** 「12 分钟」「3 小时」「2 天」；不到一分钟是「刚刚」。 */
function agoText(ms) {
  const span = Math.max(0, Number(ms) || 0);
  if (span < 60 * 1000) return '刚刚';
  const minutes = Math.round(span / 60000);
  if (minutes < 60) return minutes + ' 分钟';
  const hours = Math.round(minutes / 60);
  return hours < 48 ? hours + ' 小时' : Math.round(hours / 24) + ' 天';
}

// 首帧的配色：控制中心把 ?theme= 放在帧地址上，桌宠没有这个参数（它永远是深色）。
applyTheme(new URLSearchParams(location.search).get('theme'));

// --- 读盘 ---------------------------------------------------------------------
//
// 用户改完设置，插件的帧不会重挂；本插件没有 `events` 授权、收不到 config.changed，所以每次
// 重算都自己读一遍（一次 config.get 是 DEBUG 级的一行）。

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
