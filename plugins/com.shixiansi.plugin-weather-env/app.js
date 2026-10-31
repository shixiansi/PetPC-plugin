// app.js —— 环境感知：get_weather 工具 + 定时天气状态推送
//
// 一个文档，三种身份：
//
//   background  常驻帧：唯一的工人。定时拉默认城市天气、推状态、答 get_weather
//   workshop    控制中心插件页：当前天气卡 + 手动查任意城市（net.fetch 在桌宠侧才有）
//   (无 surface) 输出是徽标、共享键与 Tool 答案
//
// 数据流：
//
//   Open-Meteo / 和风 ──net.fetch──> 本文件 ──> share weather-now + weather-condition
//                                  └──────> pet.badge（雨/雪/高温才挂，3 小时节流）
//   模型/别的插件 ──plugin.call get_weather {city}──> {city, condition, tempC, text}
//
// 状态事件（任务书里的"根据下雨/晴天推送不同的状态事件"）：
//
//   weather-now        完整快照 {city, tempC, windKmh, condition, at}
//   weather-condition  只有 {condition, tip, at}——订阅方按 condition 分支：
//                      rain/thunder → 提醒伞、snow → 路滑、sunny+高温 → 防晒
//
// 两个名字都是**扁平名**（宿主的 shareNamePattern 只认 `[A-Za-z0-9_-]`）。写成
// `weather/now` 会被 share.set 直接拒掉——2026-10-30 的真机上刷了 18 条 WARN，
// 而订阅方本来要用 shareRead 的两段式 `com.shixiansi.plugin-weather-env/now`。
//
// 免 Key 的 Open-Meteo 是默认源；和风要 Key（config: qweatherKey + qweatherHost），
// 配了就用和风（城市先过 geoapi 拿 location id）。

'use strict';

const V = 1;
const HOST = window.parent;
let nextId = 1;
const pending = new Map();

const PERM = {
  net: 'net.fetch',
  share: 'plugin.share',
  call: 'plugin.call',
  storage: 'storage',
  config: 'plugin.config',
  surface: 'pet.surface',
};

function request(method, payload) {
  const id = 'r' + nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload ?? {} }, '*');
  });
}

let granted = new Set();
let self = { pluginId: '', slot: '' };
let cfg = {};

window.addEventListener('message', (event) => {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;
  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    case 'call':
      void onCall(data);
      break;
    default:
      break;
  }
});

// --- 小工具 -------------------------------------------------------------------

function clamp(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

function now() {
  return Date.now();
}

async function refreshConfig() {
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 沿用旧值。
  }
}

function defaultCity() {
  return clamp(String(cfg.defaultCity || '北京').trim(), 40) || '北京';
}

function pushIntervalMin() {
  const n = Number.parseInt(String(cfg.pushIntervalMin ?? '60'), 10);
  return Number.isFinite(n) ? Math.min(360, Math.max(15, n)) : 60;
}

// --- 拉天气 ---------------------------------------------------------------------

async function fetchJson(url) {
  const out = await request('net.fetch', { method: 'GET', url });
  if (!out || out.status !== 200) throw new Error(`HTTP ${out && out.status}`);
  return JSON.parse(out.body);
}

/** 查一座城市的当前天气：配了和风 Key 走和风，否则 Open-Meteo。 */
async function fetchWeather(city) {
  const key = String(cfg.qweatherKey || '').trim();
  if (key) return fetchQWeather(city, key);
  return fetchOpenMeteo(city);
}

async function fetchOpenMeteo(city) {
  // 城市名 → 经纬度走 Open-Meteo 的 geocoding（同样免 Key，域名在 netHosts 里）。
  const geo = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`);
  const hit = geo && Array.isArray(geo.results) && geo.results[0];
  if (!hit) throw new Error(`找不到城市：${city}`);
  const body = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
    `&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`);
  const weather = parseOpenMeteo(body, hit.name, now());
  if (!weather) throw new Error('天气数据解析失败');
  return weather;
}

async function fetchQWeather(city, key) {
  const host = String(cfg.qweatherHost || '').trim() || 'devapi.qweather.com';
  const geo = await fetchJson(`https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(city)}&key=${key}`);
  const hit = geo && Array.isArray(geo.location) && geo.location[0];
  if (!hit) throw new Error(`找不到城市：${city}`);
  const body = await fetchJson(`https://${host}/v7/weather/now?location=${encodeURIComponent(hit.id)}&key=${key}`);
  const weather = parseQWeather(body, hit.name, now());
  if (!weather) throw new Error(`和风天气错误（code ${body && body.code}）`);
  return weather;
}

// --- 推送：share + badge（带节流） ------------------------------------------------

let napState = {};      // { "city|condition": lastAt }
let lastBadge = null;

/**
 * 发布一次天气。返回做了什么（测试断言）。
 * 节流的是**提醒**（share + badge）；原始快照每次都存（storage/last.json，工坊页用）。
 */
async function publishWeather(weather) {
  const actions = [];
  await request('storage.set', { key: 'weather/last', value: JSON.stringify(weather) }).catch(() => {});

  const verdict = shouldNotify(napState, weather, now());
  if (verdict.ok) {
    napState = verdict.next;
    actions.push({ share: 'weather-now', value: weather });
    actions.push({
      share: 'weather-condition',
      value: { condition: weather.condition, tip: adviceFor(weather), at: weather.at },
    });
    const badge = badgeFor(weather);
    if (badge !== lastBadge) {
      actions.push({ badge });
      lastBadge = badge;
    }
  }
  for (const action of actions) {
    if (action.share && granted.has(PERM.share)) {
      await request('share.set', { name: action.share, value: JSON.stringify(action.value) }).catch(() => {});
    }
    if (action.badge !== undefined && granted.has(PERM.surface)) {
      await request('pet.badge', { text: action.badge }).catch(() => {});
    }
  }
  return actions;
}

let pollGen = 0;

function startPushLoop() {
  const gen = ++pollGen;
  const tick = async () => {
    if (gen !== pollGen) return;
    try {
      const weather = await fetchWeather(defaultCity());
      renderWorkshop(weather);
      await publishWeather(weather);
    } catch {
      // 一轮失败不算什么：网络断了下一轮再来。
    }
    if (gen === pollGen) setTimeout(tick, pushIntervalMin() * 60 * 1000);
  };
  tick();
}

function stopPush() {
  pollGen += 1;
}

// --- plugin.call：get_weather 工具 ------------------------------------------------

const CALL_HANDLERS = {
  /** {city} → {city, condition, tempC, text}。缺 city 用默认城市。 */
  get_weather: async (payload) => {
    const city = clamp(String((payload && payload.city) || '').trim(), 40) || defaultCity();
    const weather = await fetchWeather(city);
    renderWorkshop(weather);
    return weatherAnswer(weather);
  },
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `天气插件不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

function postCallResult(ticket, ok, value) {
  const message = { v: V, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  HOST.postMessage(message, '*');
}

// --- 工坊页（只读 + 手动查） -------------------------------------------------------

let currentNote = '';

function setNote(text) {
  currentNote = text || '';
  if (els.note) els.note.textContent = currentNote;
}

const els = {};

function collectEls() {
  for (const id of ['note', 'now-card', 'now-line', 'now-cond', 'lookup', 'lookup-go', 'lookup-out', 'helper-card', 'helper-state']) {
    els[id] = document.getElementById(id);
  }
}

function renderWorkshop(weather) {
  if (self.slot !== 'workshop') return;
  if (weather && els['now-line']) {
    els['now-line'].textContent = weatherAnswer(weather).text;
    if (els['now-cond']) els['now-cond'].textContent = CONDITION_LABEL[weather.condition] || weather.condition;
  }
}

async function lookupFlow() {
  const city = els.lookup ? els.lookup.value.trim() : '';
  if (!city) return;
  if (els['lookup-out']) els['lookup-out'].textContent = '查询中…';
  try {
    const answer = await CALL_HANDLERS.get_weather({ city });
    if (els['lookup-out']) els['lookup-out'].textContent = answer.text;
  } catch (err) {
    if (els['lookup-out']) els['lookup-out'].textContent = `查不到：${clamp(err && err.message, 80)}`;
  }
}

// --- init ----------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

async function onInit(data) {
  self = {
    pluginId: data.pluginId || '',
    slot: (data.surface && data.surface.slot) || '',
  };
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  applyTheme(data.theme);
  collectEls();

  await refreshConfig().catch(() => {});

  if (els['lookup-go']) {
    els['lookup-go'].addEventListener('click', () => void lookupFlow().catch(() => {}));
  }

  // 上次的天气先显示（有数据就不空着）。
  const saved = await request('storage.get', { key: 'weather/last' }).catch(() => ({ value: '' }));
  try {
    const last = JSON.parse(saved.value || 'null');
    if (last && last.city) renderWorkshop(last);
  } catch { /* 坏了就当没有 */ }

  if (self.slot === 'workshop') {
    // 控制中心不服务 net.fetch：手动查在桌宠侧才有。工坊页只显示共享的最近快照。
    if (els['lookup-go']) els['lookup-go'].disabled = !granted.has(PERM.net);
    return;
  }

  if (granted.has(PERM.net)) {
    startPushLoop();
  } else {
    setNote('未获授权：net.fetch（不会自动推送，get_weather 也答不了）');
  }
}

collectEls();
HOST.postMessage({ v: V, type: 'ready' }, '*');

/** 测试接缝。 */
window.__weather = Object.freeze({
  fetchWeather,
  publishWeather,
  stopPush,
  handlers: CALL_HANDLERS,
  snapshot: () => ({ slot: self.slot, granted: [...granted], napState: { ...napState }, lastBadge, note: currentNote }),
});
