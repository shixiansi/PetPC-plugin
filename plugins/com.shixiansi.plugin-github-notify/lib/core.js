// lib/core.js —— 文档骨架与宿主桥。
//
// 这个插件在真机上只有一副面孔：控制中心的插件页（slot: 'workshop'）。manifest 既不声明
// 浮层面也不声明常驻帧，所以桌宠那边没有它的文档。**于是 pet.badge 与 bubble.say 的每一处
// 调用前都要先问一句 serves()**：问完发现这个窗口没有宠物，就换成一行说明（手册 §9），
// 而不是先发出去再 catch —— 那正是宿主日志里几百行「本程序不支持该方法」的形状，
// catch 只让界面好看，不让日志安静。
//
// 反过来，如果将来有了桌宠侧的帧（background 或一块 surface），这套代码不用改一行：
// 轮询与通知都在 runCheck() 里，页面只是它的一个读者。

'use strict';

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map();

function byId(name) {
  return document.getElementById(name);
}

// 页面上的元素，一次查到。用的是 `hidden` 属性（ui.css 的 [hidden] 带 !important），
// 不是 .hidden 类：后者在 ui.css 里没有定义，写了也不会藏。
const els = {
  root: byId('root'), page: byId('page'), status: byId('status'),
  chipUnread: byId('chip-unread'), chipLast: byId('chip-last'),
  setup: byId('setup'), setupTitle: byId('setup-title'), setupText: byId('setup-text'),
  unreadList: byId('unread'), unreadEmpty: byId('unread-empty'),
  feedList: byId('feed'), feedEmpty: byId('feed-empty'),
  btnCheck: byId('btn-check'), btnRead: byId('btn-read'),
  badgeNote: byId('badge-note'), error: byId('error'),
};

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage(Object.assign({ v: PROTOCOL }, message), '*');
}

function request(method, payload) {
  const id = 'r' + nextRequestID++;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return promise;
}

// --- 我在哪个窗口 ------------------------------------------------------------

// 'page' = 控制中心的插件页；'pet' = 桌宠那边（今天的 manifest 不会产生它，但代码不假设这一点）。
let role = '';
let ready = false;
const self = { pluginId: '', slot: '' };
const granted = new Set();
// init.host.methods 是这个窗口真正服务的方法表；有它就别背"哪个宿主有什么"那张表。
let hostMethods = null;

/** 这个窗口服务不服务某个方法。优先问 init.host（与宿主闸门同一个答案）；没有这个字段的
 * 老宿主退回「控制中心那一面就是 workshop」。 */
function serves(method) {
  if (hostMethods) return hostMethods.includes(method);
  return role !== 'page';
}

/** 头顶那行字：要用户授予 pet.surface（pet.badge 借的就是它），并且这个窗口有宠物。 */
function canBadge() {
  return granted.has('pet.surface') && serves('pet.badge');
}

/** 气泡：要 pet.bubble，并且这个窗口有宠物。 */
function canBubble() {
  return granted.has('pet.bubble') && serves('bubble.say');
}

// --- 设置 --------------------------------------------------------------------

/** 设置项的兜底值（复制自 manifest 的 config 默认值）：`config.get` 读不到时界面还要能画出
 * "默认 10 分钟、三类都通知"，而不是一行空白。 */
const DEFAULT_CONFIG = { token: '', repos: '', intervalMinutes: '10', kinds: 'pr,issue,ci' };
let cfg = Object.assign({}, DEFAULT_CONFIG);
let lastConfigError = '';

async function refreshCfg() {
  if (!granted.has('plugin.config')) {
    lastConfigError = '这个窗口没有 plugin.config 授权：读不到设置。';
    return false;
  }
  try {
    const out = await request('config.get', {});
    const values = (out && out.values) || {};
    cfg = Object.assign({}, DEFAULT_CONFIG, values);
    lastConfigError = '';
    return true;
  } catch (err) {
    // 读不到就沿用上一次（或默认值）：一次 config.get 失败不该让整页黑掉。
    // secret 项永远读不回来（宿主只回 {set,mask}），所以 token 报错时能说的只有"去换一个"。
    lastConfigError = (err && err.message) || String(err);
    return false;
  }
}

// --- 小工具 ------------------------------------------------------------------

function nowMs() {
  return Date.now();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

/** 只往插件页写状态行；桌宠那边没有这一行。 */
function say(line) {
  if (els.status) els.status.textContent = line || '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function clampText(text, limit) {
  const s = String(text === undefined || text === null ? '' : text).trim();
  if (!s) return '';
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}
