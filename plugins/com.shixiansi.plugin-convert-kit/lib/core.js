// lib/core.js —— 文档骨架与宿主桥。
//
// 经典 script，与同目录其它文件共享一个全局作用域；加载顺序写在 panel.html 里。
// 信封与 memcore / websearch / 图床那几个插件同型：{v, type, id, method, payload}，
// 宿主拒绝时 reject 的是宿主那句中文，原样显示给用户（手册 §5.3 铁律 5）。
//
// 两副面孔（由 init.surface.slot 决定，不猜——常驻帧的 kind 也是 'panel'，见手册 §5.2）：
//
//   workshop   控制中心的插件页：换算的全部界面（lib/panel.js）。
//   background 桌宠挂的常驻无名帧：什么都不画，只答别的插件的 plugin.call convert。
//
// 为什么后台帧必须有：`serves` 要有人接电话。没有常驻帧时，别的插件来问 convert 只会立刻
// 拿到"没有帧"，等下去也不会出现一个。manifest 的 background 就是这份接线。

'use strict';

// --- 桥 -----------------------------------------------------------------------

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map(); // requestId -> {resolve, reject}

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

function request(method, payload) {
  const id = String(nextRequestID++);
  return new Promise((resolve, reject) => {
    // 先登记再发：宿主可能在同一个任务里就答（自检工具的假宿主就是这么做的）。
    pending.set(id, { resolve, reject });
    postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  });
}

/** 一次 plugin.call 的回包。ticket 原样带回——带错了宿主不认，调用方只会等到超时。 */
function postCallResult(ticket, ok, value) {
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

// --- 状态 ---------------------------------------------------------------------

const granted = new Set();
let self = { pluginId: '', slot: '' };

// 这里故意**没有** `init.host` 那一套"这个窗口服务不服务 X"的判断：本插件只调
// config.get / storage.*，而它们在两个宿主里都服务（手册 §9 那张表），所以没有哪一处需要问。
// 真需要按窗口分叉时再看 host.methods——别凭印象背那张表。

// --- 设置与存储 ---------------------------------------------------------------

/** 设置项的默认值：读不到配置（没授权、宿主拒绝）时界面也得能用。 */
let cfg = { decimals: 2, defaultCategory: 'length', showRates: true };
let configPromise = null;

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 读一次设置。**只在握手时读**，并且失败就保留默认值。
 *
 * 用户的设置在控制中心的设置页里改，宿主会推 config.changed（手册 §7），那时 invalidate + 重读；
 * 除此之外不去轮询 config.get——它是 DEBUG 级管道，但每 5 秒一次就会把日志写成噪音。
 */
function ensureConfig() {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    if (!granted.has('plugin.config')) return cfg;
    try {
      const out = await request('config.get', {});
      const values = (out && out.values) || {};
      cfg = {
        decimals: clampInt(values.decimals, 0, 8, 2),
        defaultCategory: String(values.defaultCategory || 'length'),
        showRates: values.showRates === 'false' ? false : values.showRates === 'true' ? true : true,
      };
    } catch {
      // 一次 config.get 失败不该让换算停摆：默认值就是"没说过的样子"。
    }
    return cfg;
  })();
  return configPromise;
}

function invalidateConfig() {
  configPromise = null;
}

/** 读一个 JSON 值。没有 storage 权限就连问都不问（一次被拒的请求就是宿主日志里一行 WARN）。 */
async function readJSON(key, fallback) {
  if (!granted.has('storage')) return fallback;
  try {
    const out = await request('storage.get', { key });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJSON(key, value) {
  await request('storage.set', { key, value: JSON.stringify(value) });
}

// --- 小工具 -------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 状态行。它存在的原因：这个帧里没有 devtools，宿主日志也只记方法名。 */
function say(line) {
  const node = document.getElementById('status');
  if (node) node.textContent = line || '';
}

/**
 * 跑一段可能失败的异步代码，失败只说一句话。
 *
 * 为什么需要：`void someAsync()` 的失败会变成 unhandledrejection，而插件帧里没有任何人看得见
 * 它——界面停在上一步，用户看到的是"点了没反应"。
 */
function guard(fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => say((err && err.message) || String(err)));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));
