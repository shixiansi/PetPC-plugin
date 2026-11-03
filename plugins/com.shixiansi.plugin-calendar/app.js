// 日程日历：常驻帧拉 ICS、算提醒、答 plugin.call；浮层面/插件页画今天与明天。
//
// 一个文档，三种挂载（由 init 的 surface 决定，见 panel.html 顶部注释）。"现在几点 /
// 本地在哪个时区"统一走 clock()：常驻帧给真实时钟，测试注入固定值——业务逻辑里不散落
// new Date()。
//
// 轮询纪律（§7）：设置与缓存的变化由 events（config.changed）即时反应；15 秒兜底拉起
// 可能错过的变化。没有一秒级的文件或状态轮询——每分钟那次只服务"跨天重绘"。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-calendar';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `c${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: PROTOCOL, type: 'request', id, method, payload: payload || {} }, '*');
  });
}

// --- 时钟（测试接缝：__calendar.setClock 注入"今天 = 2026-01-01"） -----------------

const clock = { nowMs: () => Date.now(), offsetMin: () => -new Date().getTimezoneOffset() };
function nowMs() { return clock.nowMs(); }
function localOffsetMin() { return clock.offsetMin(); }

// --- 状态 --------------------------------------------------------------------

let self = { slot: '', kind: '', hostMethods: null };
let cfg = { icsUrl: '', refreshMin: 60, remindMin: 10 };
let ready = false;

// 解析过的日历（CalendarICS.parseICS 的 events）、它的 VTIMEZONE 表、最近一次成功拉取的时刻。
let events = [];
let zones = null;
let lastFetched = 0;
// 视图缓存：同一本地日只画一次；dayKey/内容没变就不动 DOM。
let viewKey = '';
let refreshTimer = null;
// 订阅过才收得到 config.changed（§7）：失败不致命，15 秒兜底的重绘检查还在。
let subscribed = false;

// 这一面有没有"宿主服务这个方法"的权威答案（§5.2.1）：有 host 表就查表，没有退回 slot 猜。
function hostServes(method) {
  if (self.hostMethods) return self.hostMethods.indexOf(method) >= 0;
  if (self.slot === 'workshop') return false; // 控制中心没有 pet 专属方法（§9 的表）
  return true;
}

// 提醒（bubble.say）只有桌宠服务。
function canBubble() {
  return granted.has('pet.bubble') && hostServes('bubble.say');
}

// --- 日历的拉取与解析 ---------------------------------------------------------

const KEY_CACHE = 'ics/cache';        // 上一次拉到的 ICS 文本：断网时的答案就在这里
const KEY_FETCHED = 'ics/fetched-at'; // 上一次成功拉取的时刻（毫秒）

function refreshIntervalMs() {
  const n = Number(cfg.refreshMin);
  return Number.isFinite(n) && n > 0 ? n * 60000 : 0;
}

function scheduleRefresh() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  const ms = refreshIntervalMs();
  // 失败不立刻重试（会打成风暴）：下一次尝试至少隔一个完整周期。
  if (ms > 0 && granted.has('net.fetch')) refreshTimer = setTimeout(() => { void refreshNow(); }, ms);
}

/** 拉一次日历。任何失败都静默落到缓存（lastFetched 没变，界面照常显示旧数据）。 */
async function refreshNow() {
  if (!granted.has('net.fetch') || !cfg.icsUrl) return;
  let text = '';
  try {
    const res = await request('net.fetch', { method: 'GET', url: cfg.icsUrl });
    text = String((res && res.body) || '');
    if (res && res.truncated) text = ''; // 截断的 ICS 末尾事件残缺，整份不可信
  } catch {
    text = ''; // 断网：落到缓存，下面的分支一个都不走
  }
  if (text && /BEGIN:VCALENDAR/i.test(text)) {
    const parsed = window.CalendarICS.parseICS(text);
    if (parsed.events.length > 0 || parsed.skipped === 0) {
      // 空日历也是合法答案（真的没有日程）；但"全解析失败"更像格式变了，保留旧缓存。
      // zones 跟着这份日历走：RRULE 的 UNTIL 与换算要在解析时的时区里算。
      events = parsed.events;
      zones = parsed.zones;
      lastFetched = nowMs();
      if (granted.has('storage')) {
        // ICS 全文进一个键；>1MiB 宿主会拒写，那就放弃全文缓存（解析结果已在内存里）。
        const keep = text.length <= 900000 ? text : '';
        await request('storage.set', { key: KEY_CACHE, value: keep }).catch(() => {});
        await request('storage.set', { key: KEY_FETCHED, value: String(lastFetched) }).catch(() => {});
      }
    }
  }
  scheduleRefresh();
  paint();
}

/** 启动时读缓存与配置；缓存是断网 3 天仍能回答"今天有什么"的那份。 */
async function loadCached() {
  if (!granted.has('storage')) return;
  const [cached, at] = await Promise.all([
    request('storage.get', { key: KEY_CACHE }).catch(() => ({ value: '' })),
    request('storage.get', { key: KEY_FETCHED }).catch(() => ({ value: '' })),
  ]);
  const text = String((cached && cached.value) || '');
  lastFetched = Number((at && at.value) || 0) || 0;
  if (text && /BEGIN:VCALENDAR/i.test(text)) {
    const parsed = window.CalendarICS.parseICS(text);
    events = parsed.events;
    zones = parsed.zones;
  }
}

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  const res = await request('config.get', {}).catch(() => null);
  if (!res || !res.values) return;
  const prevUrl = cfg.icsUrl;
  cfg.icsUrl = String(res.values.icsUrl || '').trim();
  cfg.refreshMin = Number(res.values.refreshMin) || 0;
  cfg.remindMin = Number(res.values.remindMin);
  if (!Number.isFinite(cfg.remindMin) || cfg.remindMin < 0) cfg.remindMin = 10;
  // 订阅地址变了，旧缓存答的是另一本日历——立刻丢掉，宁可先空着。
  if (prevUrl && cfg.icsUrl && prevUrl !== cfg.icsUrl) {
    events = [];
    zones = null;
    lastFetched = 0;
  }
}

// config.changed 只发给订阅过的帧（§7）：订阅一次，失败不致命——兜底的重绘检查还在。
async function subscribeEvents() {
  if (subscribed || !granted.has('events') || !hostServes('events.subscribe')) return;
  subscribed = true;
  await request('events.subscribe', { names: ['config.changed'] }).catch(() => { subscribed = false; });
}

// --- 查询：三个 serve 的实现 ---------------------------------------------------

// [fromMs, toMs) 内的发生，附上本地时间的字符串。本地偏移用查看者此刻的——跨时区
// 换算只在这里发生一次。
function windowEvents(fromMs, toMs) {
  const off = localOffsetMin();
  const out = window.CalendarICS.expandWindow(events, zones, { fromMs, toMs, offsetMin: off });
  for (const e of out) {
    e.localStart = window.CalendarICS.fmtLocal(e.startMs, off);
    e.localEnd = window.CalendarICS.fmtLocal(e.endMs, off);
  }
  return out;
}

function dayKey(offsetDays, off) {
  return window.CalendarICS.dayKeyOf(nowMs() + offsetDays * 86400000, off);
}

/** today → 今天的日程数组（含进行中；刚结束一小时内也算，散会还能找到人）。 */
async function answerToday() {
  const off = localOffsetMin();
  const start = window.CalendarICS.dayStartMs(dayKey(0, off), off);
  const list = windowEvents(start, start + 86400000)
    .filter((e) => e.endMs > nowMs() - 3600000)
    .map((e) => ({ title: e.title, location: e.location, allDay: e.allDay, start: e.localStart, end: e.localEnd, startMs: e.startMs, endMs: e.endMs }));
  return { date: dayKey(0, off), count: list.length, stale: isStale(), events: list };
}

/** next → 下一个未结束的日程（进行中的也算：它"还开着会"）。 */
async function answerNext() {
  const off = localOffsetMin();
  const start = window.CalendarICS.dayStartMs(dayKey(0, off), off);
  const list = windowEvents(start - 86400000, start + 31 * 86400000).filter((e) => e.endMs > nowMs());
  const e = list[0] || null;
  return e
    ? { title: e.title, location: e.location, allDay: e.allDay, start: e.localStart, end: e.localEnd, startMs: e.startMs, endMs: e.endMs, ongoing: e.startMs <= nowMs(), stale: isStale() }
    : { title: '', stale: isStale() };
}

/** agenda(days) → 未来 N 天（从今天算），默认 7，上限 31。 */
async function answerAgenda(payload) {
  const days = Math.max(1, Math.min(31, Math.floor(Number(payload && payload.days) || 7)));
  const off = localOffsetMin();
  const start = window.CalendarICS.dayStartMs(dayKey(0, off), off);
  const list = windowEvents(start, start + days * 86400000)
    .map((e) => ({ title: e.title, location: e.location, allDay: e.allDay, start: e.localStart, end: e.localEnd, startMs: e.startMs, endMs: e.endMs }));
  return { from: dayKey(0, off), days, count: list.length, stale: isStale(), events: list };
}

const CALL_HANDLERS = {
  today: answerToday,
  next: answerNext,
  agenda: (payload) => answerAgenda(payload || {}),
};

// 上次成功拉取超过 3 天 = 缓存里的答案可能已经过时（重复事件按 COUNT/UNTIL 展开完就没有了）。
function isStale() {
  return lastFetched > 0 && nowMs() - lastFetched > 3 * 86400000;
}

// --- 会前提醒 ------------------------------------------------------------------

let remindTimer = null;
// 只提醒"下一次"。气泡只有一个，最吵的翻车就是提醒风暴：一条一条往外弹、或每分钟把
// 同一件事再弹一遍。remindedAt 记住"哪个发生已经提过"。
let remindedAt = -1;

function scheduleRemindTick() {
  if (remindTimer) { clearTimeout(remindTimer); remindTimer = null; }
  if (!canBubble() || cfg.remindMin <= 0) return;
  remindTimer = setTimeout(() => { remindTick(); }, 20000);
}

function remindTick() {
  scheduleRemindTick();
  if (!granted.has('pet.bubble') || cfg.remindMin <= 0) return;
  const now = nowMs();
  const off = localOffsetMin();
  const start = window.CalendarICS.dayStartMs(dayKey(0, off), off);
  const upcoming = windowEvents(start, start + 2 * 86400000).filter((e) => e.endMs > now);
  for (const e of upcoming) {
    const lead = e.startMs - now;
    if (lead > 0 && lead <= cfg.remindMin * 60000) {
      if (remindedAt === e.startMs) break;
      remindedAt = e.startMs;
      const hhmm = window.CalendarICS.fmtLocal(e.startMs, off).slice(11, 16);
      void request('bubble.say', { text: lead < 60000 ? `${hhmm} ${e.title} 马上开始` : `${hhmm} ${e.title}，${Math.round(lead / 60000)} 分钟后开始` }).catch(() => {});
      break; // 一次只提最近的一场
    }
    if (e.startMs > now + cfg.remindMin * 60000) break;
  }
}

// --- plugin.call 的应答 --------------------------------------------------------

function postCallResult(ticket, ok, valueOrErr) {
  const msg = ok
    ? { v: PROTOCOL, type: 'call-result', ticket, ok, result: valueOrErr }
    : { v: PROTOCOL, type: 'call-result', ticket, ok, error: String((valueOrErr && valueOrErr.message) || valueOrErr) };
  HOST.postMessage(msg, '*');
}

/** 必须与 manifest 的 serves 逐字相同（测试里钉住）：少一边，调用方等到 30 秒超时。 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(`日历不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

// --- 视图 ---------------------------------------------------------------------

const els = {};
function grabEls() {
  for (const id of ['root', 'status', 'card', 'today', 'tomorrow', 'today-label', 'tomorrow-label', 'note']) {
    els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function renderList(node, list) {
  node.textContent = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '没有日程';
    node.appendChild(p);
    return;
  }
  const off = localOffsetMin();
  const now = nowMs();
  for (const e of list) {
    const row = document.createElement('div');
    row.className = 'row' + (e.startMs <= now && e.endMs > now ? ' now' : '') + (e.allDay ? ' all-day' : '');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = e.allDay ? '全天' : `${e.localStart.slice(11, 16)} – ${e.localEnd.slice(11, 16)}`;
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = e.title + (e.location ? `（${e.location}）` : '');
    row.appendChild(time);
    row.appendChild(text);
    node.appendChild(row);
  }
}

/** 重画视图。每分钟的 tick 也会调它，但 dayKey/内容没变时在这里直接返回。 */
function paint() {
  if (!els.card || self.kind !== 'surface') return;
  const off = localOffsetMin();
  const today = dayKey(0, off);
  const tomorrow = dayKey(1, off);
  const key = `${today}|${events.length}|${lastFetched}`;
  if (key === viewKey) return; // 钟点走了、日期没走：列表不会变，不动 DOM
  viewKey = key;
  const startToday = window.CalendarICS.dayStartMs(today, off);
  const startTomorrow = window.CalendarICS.dayStartMs(tomorrow, off);
  renderList(els.today, windowEvents(startToday, startToday + 86400000).filter((e) => e.endMs > nowMs() - 3600000));
  renderList(els.tomorrow, windowEvents(startTomorrow, startTomorrow + 86400000));
  if (els.note) {
    if (events.length === 0 && cfg.icsUrl && !granted.has('net.fetch')) {
      els.note.hidden = false;
      els.note.textContent = '未获授权 net.fetch：拉不到日历';
    } else if (isStale()) {
      els.note.hidden = false;
      els.note.textContent = '日历超过 3 天没刷新，以下可能不是最新的';
    } else if (lastFetched > 0 && !granted.has('net.fetch')) {
      els.note.hidden = false;
      els.note.textContent = '离线中，显示的是上一次拉到的日历';
    } else {
      els.note.hidden = true;
    }
  }
  reportHeight();
}

// 浮层面的高度跟内容走（§6.5）：宿主只对声明了 maxH 的块应用 sizes，maxH=300 在 manifest 里。
let heightTimer = null;
function reportHeight() {
  if (self.kind !== 'surface' || !granted.has('pet.surface') || !els.card) return;
  clearTimeout(heightTimer);
  // 防抖到期一定会发（不是"窗口内只发一次"）：每条消息都表示"这是现在的高度"。
  heightTimer = setTimeout(() => {
    request('surface.blocks', { sizes: { '0': Math.min(300, Math.ceil(document.body.scrollHeight) + 2) } }).catch(() => {});
  }, 120);
}

// --- 启动 ---------------------------------------------------------------------

async function onInit(data) {
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  const surf = data.surface || {};
  self = {
    kind: surf.kind || 'panel',
    slot: surf.slot || '',
    hostMethods: data.host && Array.isArray(data.host.methods) ? data.host.methods : null,
  };
  applyTheme(data.theme);
  ready = true;
  viewKey = '';

  if (els.root) {
    els.root.classList.remove('view-boot');
    if (self.kind === 'surface') els.root.classList.add('view-surface');
    else if (self.slot === 'background') els.root.classList.add('bg');
  }
  if (els.status) {
    els.status.textContent = self.slot === 'workshop'
      ? '日程在桌宠那边显示'
      : granted.has('net.fetch') ? '已就绪' : '未获授权：net.fetch';
  }

  await refreshConfig().catch(() => {});
  await loadCached().catch(() => {});
  await subscribeEvents();
  paint();

  // 拉日历的必要条件在 refreshNow 里再查一遍；这里只决定"要不要马上拉第一次"。
  if (granted.has('net.fetch') && cfg.icsUrl) void refreshNow();
  scheduleRefresh();
  scheduleRemindTick();
}

// events（config.changed）做即时反应，不轮询配置。
function onHostEvent(name, payload) {
  if (name === 'config.changed' && (!payload || payload.pluginId === PLUGIN_ID)) {
    void (async () => {
      await refreshConfig().catch(() => {});
      await loadCached().catch(() => {});
      scheduleRefresh();
      if (granted.has('net.fetch') && cfg.icsUrl) void refreshNow();
      paint();
    })();
  }
}

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return; // 迟到的 response：安全丢弃
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '宿主拒绝了这次调用'));
}

function onMessage(event) {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init': void onInit(data); break;
    case 'response': onResponse(data); break;
    case 'theme': applyTheme(data.theme); break;
    case 'event': onHostEvent(String(data.name || ''), data.payload); break;
    case 'call': void onCall(data); break;
    default: break; // surface / 未知类型：忽略是协议要求的宽容
  }
}

window.addEventListener('message', onMessage);
// 兜底间隔：重绘检查 + "可能错过的变化"的最后一道。15 秒是手册给的兜底拍子（§7.2）；
// 跨天才需要重绘，所以 dayKey 没变时 paint 直接返回——这不是每 15 秒一次的重排。
let lastMinute = -1;
setInterval(() => {
  if (!ready) return;
  const m = Math.floor(nowMs() / 60000);
  if (m !== lastMinute) {
    lastMinute = m;
    viewKey = '';
    paint();
  }
}, 15000);

grabEls();
// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');

/**
 * 测试接缝：常驻帧被 plugin.call 问、日历在没人看着时刷新——行为发生在看不见的那一面。
 * 纯解析在 window.CalendarICS（lib/ics.js）；这里的函数是"接了宿主的那些"。
 */
window.__calendar = Object.freeze({
  answerToday,
  answerNext,
  answerAgenda,
  refreshNow,
  loadCached,
  refreshConfig,
  handlers: CALL_HANDLERS,
  setClock: (nowMsOverride, offsetMinOverride) => {
    clock.nowMs = nowMsOverride || clock.nowMs;
    clock.offsetMin = offsetMinOverride != null ? () => offsetMinOverride : clock.offsetMin;
  },
  snapshot: () => ({
    slot: self.slot,
    kind: self.kind,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    eventCount: events.length,
    lastFetched,
    subscribed,
  }),
});
