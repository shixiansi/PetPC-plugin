// lib/core.js —— 文档骨架、宿主桥、设置、小工具
//
// 与 imgbed / rss-reader 的 core.js 同一封信封：{v, type, id, method, payload}。宿主拒绝时
// reject 的是宿主自己那句中文（「未获权限 net.fetch」「本程序不支持该方法 X」），原样显示。

'use strict';

const els = {
  root: document.getElementById('root'), workshop: document.getElementById('workshop'),
  chipCount: document.getElementById('chip-count'), chipInterval: document.getElementById('chip-interval'),
  chipQuiet: document.getElementById('chip-quiet'), entries: document.getElementById('entries'),
  entriesEmpty: document.getElementById('entries-empty'), changes: document.getElementById('changes'),
  changesEmpty: document.getElementById('changes-empty'), refresh: document.getElementById('refresh'),
  status: document.getElementById('status'),
};

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

// --- 状态 ---------------------------------------------------------------------

const granted = new Set();
/** `init.host` 的方法表：有它就别背"哪个窗口服务什么"那张表（手册 §5.2.1）。 */
let hostMethods = null;
let self = { pluginId: '', slot: '', program: '' };
let ready = false;
/** 上一次读到的设置（没读到过就是下面这份默认值）。 */
let cfg = {};
let cfgError = '';

/**
 * 默认值**在 JS 里再写一份**：宿主的 `config.get` 只回 config.json 里真的有的键（ConfigStore.Read
 * 只遍历磁盘上存过的值），manifest 里的 `default` 是给宿主设置表单当占位用的。所以"用户还没打过
 * 设置"读到的是一份空对象——间隔与免打扰必须有 JS 侧兜底，否则第一轮就是 NaN。
 */
const CFG_DEFAULTS = { entries: '', intervalMin: '60', quietFrom: '22:00', quietTo: '08:00' };

// --- storage / config ---------------------------------------------------------

async function readJSON(key, fallback) {
  const out = await request('storage.get', { key });
  const raw = out && typeof out.value === 'string' ? out.value : '';
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    // 写坏的一条不值得让整轮监控停下：当成"没有历史"（等于重新建立基线）。
    return fallback;
  }
}

async function writeJSON(key, value) {
  await request('storage.set', { key, value: JSON.stringify(value) });
}

/**
 * 重读设置。**抛异常**而不是静默：调用方要区分"设置读不到"（宿主拒绝了这次调用：整轮停下，也不
 * 往私有目录写任何东西）与"这一条抓不到"（站点的问题：保留旧快照）。
 */
async function refreshConfig() {
  if (!granted.has('plugin.config')) {
    cfgError = '未获授权：plugin.config（读不到监控条目，监控不会运行）';
    cfg = { ...CFG_DEFAULTS };
    throw new Error(cfgError);
  }
  const out = await request('config.get', {});
  cfg = Object.assign({}, CFG_DEFAULTS, (out && out.values) || {});
  cfgError = '';
  return cfg;
}

// --- 小工具 -------------------------------------------------------------------

function now() {
  return Date.now();
}

function text(value, max) {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const limit = Number.isFinite(max) && max > 0 ? max : 2000;
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function num(key, min, max, fallback) {
  const n = Number.parseInt(String(cfg[key] === undefined || cfg[key] === null ? '' : cfg[key]), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 抓取间隔。**下限 15 分钟**是硬约定：1 秒轮询是本项目的反模式（手册 §7.2 / AGENTS §3.9）。 */
function intervalMs() {
  return num('intervalMin', 15, 24 * 60, 60) * 60000;
}

/** HH:MM → 当天分钟数；认不出来返回 null。 */
function parseClock(value) {
  const m = /^(\d{1,2})\s*:\s*(\d{1,2})$/.exec(String(value === undefined ? '' : value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 现在是不是免打扰时段。默认配置**跨午夜**（22:00→08:00），这是唯一需要小心的那一种：`from > to`
 * 时"在段内"是 `t >= from || t < to`，不是区间比较。起止相同 = 全天免打扰；两段都得写对，否则
 * "整天免打扰"和"从来没配"会混成一件事。
 */
function isQuietAt(ms) {
  const from = parseClock(cfg.quietFrom);
  const to = parseClock(cfg.quietTo);
  if (from === null || to === null) return false;
  if (from === to) return true;
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const t = d.getHours() * 60 + d.getMinutes();
  return from < to ? t >= from && t < to : t >= from || t < to;
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const pad = (x) => `${x}`.padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "23 分钟前"——比一个绝对时间戳更能回答"上次成功是什么时候"。 */
function fmtAgo(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '还没有成功过';
  const minutes = Math.floor(Math.max(0, Date.now() - n) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

function say(line) {
  if (els.status) els.status.textContent = line || '';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 只有桌宠服务的那几个方法（`init.host` 缺席时的兜底表，手册 §9）。 */
const PET_ONLY = new Set([
  'bubble.say', 'events.subscribe', 'surface.show', 'surface.hide', 'surface.blocks', 'pet.badge',
  'llm.chat', 'llm.profile', 'llm.providers', 'memory.read', 'memory.append', 'plugin.call',
  'ws.open', 'ws.send', 'ws.close', 'ws.state', 'process.launch', 'process.state', 'process.kill',
]);

/**
 * 这个窗口服务不服务某个方法：优先问 `init.host.methods`（宿主自己的答案，与闸门同一张表），没有
 * 它时才退回 slot 判断——控制中心给的是 `workshop`，其余都是桌宠。
 */
function hostServes(method) {
  if (hostMethods) return hostMethods.includes(method);
  return self.slot === 'workshop' ? !PET_ONLY.has(method) : true;
}

applyTheme(new URLSearchParams(location.search).get('theme'));
