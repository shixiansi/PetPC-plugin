// lib/core.js —— 文档骨架与宿主桥
//
// 经典 script，与同目录其它文件共享一个全局作用域（加载顺序写在 panel.html 里）。信封与
// imgbed / rss-reader 同型：{v, type, id, method, payload}；宿主拒绝时 reject 的是它那句中文。
// 一个文档三种面孔（kind 与 slot 一起看：浮层面的 kind 是 'surface' 而**没有 slot**，常驻帧的
// kind 是 'panel'、slot 是 'background'）：workshop / surface / background，分工见 app.js 文件头。
'use strict';

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map();
const granted = new Set();
const mountInfo = { kind: 'panel', slot: '', rect: null, rectIndex: 0 };
let hostMethods = null; // init.host.methods：这个窗口真正服务的方法（null = 老宿主）
let selfId = '';
// config.get 的最近一份。**定时器里只读这份内存副本**：会前提醒 20 秒一拍，让它每拍去问一次
// config.get 就是手册 §7 说的那种"有事件可听的轮询"。
const cfg = {};

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
  else message.error = String((value && value.message) || value);
  postToHost(message);
}

/**
 * 这个窗口服务不服务某个方法。优先问 init.host（宿主自己算出来的表，和闸门是同一个答案），
 * 没有它的老宿主退回 slot。**永远不要**先发出去、被拒了再兜底：那正是日志里几百行
 * "本程序不支持该方法"的来源，而插件的 catch 只让界面好看，不让日志安静（手册 §9）。
 */
function serves(method) {
  if (hostMethods) return hostMethods.includes(method);
  return mountInfo.slot !== 'workshop';
}

function can(permission) { return granted.has(permission); }
function el(id) { return document.getElementById(id); }

const els = {
  body: document.body, boot: el('boot-note'),
  surface: el('surface'), sfState: el('sf-state'), sfMain: el('sf-main'),
  sfTime: el('sf-time'), sfWhat: el('sf-what'), sfEmpty: el('sf-empty'), sfFoot: el('sf-foot'),
  workshop: el('workshop'), wsState: el('ws-state'), wsRefresh: el('ws-refresh'),
  wsCache: el('ws-cache'), wsSettings: el('ws-settings'), wsUrl: el('ws-url'),
  wsSave: el('ws-save'), wsNeedUrl: el('ws-need-url'), wsNeedText: el('ws-need-text'),
  wsDays: el('ws-days'), wsEmpty: el('ws-empty'),
};

/** 解析一段可能是坏 JSON 的文本（缓存元数据、提醒账本）：坏了一律当空。 */
function jsonOr(raw, fallback) {
  try {
    const parsed = raw ? JSON.parse(raw) : fallback;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

/** 显隐。**只管这一层**：藏之前先确认要藏的是控件还是容器（§8.2b 的第二次翻车）。 */
function show(node, visible) { if (node) node.classList.toggle('hidden', !visible); }

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

/** 按当前窗口重画。两个 painter 由 lib/views.js 提供，都是函数声明（那时都已执行过）。 */
function paint() {
  if (mountInfo.slot === 'workshop') paintWorkshop();
  else if (isSurfaceMount()) paintSurface();
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cfgText(key, fallback) {
  const raw = cfg[key];
  if (raw === undefined || raw === null) return fallback === undefined ? '' : fallback;
  return String(raw);
}
function cfgNum(key, min, max, fallback) { return clampInt(cfgText(key, ''), min, max, fallback); }

function cfgBool(key, fallback) {
  const raw = cfgText(key, '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/** HH:mm（本机时区）。日程是给人看的钟点，时区换算只在这一层发生。 */
function hm(ms) {
  const d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function localMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "今天 · 11月5日"。按**本机日历日**算，和用户看到的钟一致。 */
function dayLabel(ms, nowMs) {
  const d = new Date(ms);
  const base = d.getMonth() + 1 + '月' + d.getDate() + '日';
  const days = Math.round((localMidnight(ms) - localMidnight(nowMs)) / 86400000);
  if (days === 0) return '今天 · ' + base;
  if (days === 1) return '明天 · ' + base;
  if (days === 2) return '后天 · ' + base;
  return base + ' ' + WEEKDAYS[d.getDay()];
}

/** "刚刚 / 12 分钟前 / 3 小时前"。缓存有没有说服力，全看这一行。 */
function ageText(ms, nowMs) {
  const diff = Math.max(0, (Number.isFinite(nowMs) ? nowMs : Date.now()) - ms);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? hours + ' 小时前' : Math.floor(hours / 24) + ' 天前';
}

/**
 * 重读设置。用户在宿主的设置表单里改完，插件的帧不会重挂，所以每次刷新前重读一遍
 * （手册 §6.4：除了 config.changed 那条事件，宿主不会主动通知）。
 */
async function refreshConfig() {
  if (!can('plugin.config')) return;
  try {
    const out = await request('config.get', {});
    Object.assign(cfg, (out && out.values) || {});
  } catch {
  }
}

async function readKey(key, fallback) {
  if (!can('storage')) return fallback;
  try {
    const out = await request('storage.get', { key });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    return raw === '' ? fallback : raw;
  } catch { return fallback; }
}

async function writeKey(key, value) {
  if (!can('storage')) return false;
  try {
    await request('storage.set', { key, value: String(value) });
    return true;
  } catch { return false; }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 给页面上的失败文案：宿主的 error 已经是一句中文，不要再包成"操作失败"。 */
function errorText(err) { return String((err && err.message) || err || '未知原因'); }

applyTheme(new URLSearchParams(location.search).get('theme'));
