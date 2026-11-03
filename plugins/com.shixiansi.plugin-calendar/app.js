// app.js —— 握手、三副面孔的分派、以及 plugin.call 的应答（与 rss-reader / imgbed 同一型）。
// 骨架：background 抓取 + 会前提醒 + 开关卡片 + 答 plugin.call（"用户没看着也在办"的事只能住在
// 常驻帧里）；surface 只读缓存画下一场；workshop 是列表 / 刷新 / 改地址，它那一面没有宠物。
'use strict';

/** `plugin.call` 能问的方法。**必须与 manifest 的 serves 逐字相同**：写了没实现，调用方等 30 秒超时。 */
const CALL_HANDLERS = { today: serveToday, next: serveNext, agenda: serveAgenda };

let initSeen = false;
let surfaceVisible = false;
let timersStarted = false;

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return; // 过期或未知的 id：丢掉，不要报错
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '宿主拒绝了这次调用'));
}

function onEvent(data) {
  const name = String(data.name || '');
  const payload = data.payload || {};
  if (name === 'config.changed') {
    if (payload.pluginId && selfId && String(payload.pluginId) !== selfId) return;
    void reloadAfterConfigChange();
  } else if (name === 'storage.changed') {
    void pollCache();
  }
}

async function reloadAfterConfigChange() {
  await refreshConfig();
  paint();
  if (mountInfo.slot === 'background' && can('net.fetch') && normalizeFeedUrl(feedConfiguredRaw())) {
    await feedRefresh();
    await syncSurfaceCard(Date.now());
  }
  paint();
}

/** 答一次 plugin.call。三种结局都要回一条 call-result——包括「我不认识这个方法」。 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = String(data.method || '');
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    const known = Object.keys(CALL_HANDLERS).join(' / ');
    postCallResult(ticket, false, new Error('日程日历不认识方法 ' + (method || '(空)') + '：它只回答 ' + known));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      if (initSeen) return; // 同一个文档只握手一次
      initSeen = true;
      void onInit(data).catch((err) => textOf(els.wsState, '初始化失败：' + errorText(err)));
      break;
    case 'response': onResponse(data); break;
    case 'theme': applyTheme(data.theme); break;
    case 'event': onEvent(data); break;
    case 'call': void onCall(data); break;
    case 'surface':
      if (data.rect) mountInfo.rect = data.rect;
      paint();
      break;
    default: break;
  }
}

async function onInit(data) {
  for (const name of data.granted || []) granted.add(name);
  const surface = data.surface || {};
  const host = data.host || null;
  hostMethods = host && Array.isArray(host.methods) ? host.methods.slice() : null;
  const kind = String(surface.kind || 'panel');
  // 浮层面的 kind 是 'surface' 而**没有 slot**；常驻帧的 kind 是 'panel'、slot 是 'background'。
  Object.assign(mountInfo, {
    kind,
    slot: String(surface.slot || (kind === 'surface' ? 'surface' : 'panel')),
    rect: surface.rect || null,
    rectIndex: Number(surface.rectIndex) || 0,
  });
  selfId = String(data.pluginId || '');
  if (data.theme) applyTheme(data.theme);
  show(els.boot, false);
  show(els.surface, isSurfaceMount());
  show(els.workshop, mountInfo.slot === 'workshop');
  // data-view 是给 CSS 用的（body[data-view='surface'] 关掉那句 boot 文案）：同样按 kind 判，
  // 因为浮层面可能带着一个面板槽名过来（见 lib/core.js 的 isSurfaceMount）。
  if (els.body) els.body.dataset.view = isSurfaceMount() ? 'surface' : (mountInfo.slot || 'panel');

  if (!can('storage') && !can('plugin.config')) {
    paintUnauthorized();
    return;
  }
  await refreshConfig();
  await feedLoadCache();
  await reminderLoad();
  if (can('events') && serves('events.subscribe')) {
    request('events.subscribe', { names: ['config.changed'] }).catch(() => {});
  }
  paint();
  await initialFetch();
  paint();
  startTimers();
  if (mountInfo.slot === 'background') {
    await reminderTick(Date.now());
    await syncSurfaceCard(Date.now());
  }
}

/** 开局要不要抓一次网络。卡片那一面永远不抓：它是视图，不是引擎。 */
async function initialFetch() {
  if (!can('net.fetch') || !normalizeFeedUrl(feedConfiguredRaw()) || !feedStale(Date.now())) return;
  if (mountInfo.slot === 'background') await feedRefresh();
  if (mountInfo.slot === 'workshop') await workshopRefresh();
}

function startTimers() {
  if (timersStarted) return;
  timersStarted = true;
  // 钟表类定时器（§3.9 的例外）：20 秒一拍判"距开始还剩几分钟"。1 秒一拍只会多 20 倍唤醒。
  if (mountInfo.slot === 'background') {
    setInterval(() => { void backgroundTick(); }, 20000);
    return;
  }
  // 另外两面只读缓存：主路径是 storage.changed，这个 15 秒的只是兜底（事件可能丢）。
  setInterval(() => { void pollCache(); }, 15000);
}

async function backgroundTick() {
  const nowMs = Date.now();
  if (!can('storage')) return;
  if (can('net.fetch') && normalizeFeedUrl(feedConfiguredRaw()) && feedStale(nowMs)) await feedRefresh();
  await reminderTick(nowMs);
  await syncSurfaceCard(nowMs);
}

async function pollCache() {
  if (!can('storage') || !feedState.fetchedAt) return;
  const meta = jsonOr(await readKey(KEY_FEED_META, ''), {});
  if ((Number(meta.fetchedAt) || 0) === feedState.fetchedAt) return;
  await feedLoadCache();
  paint();
}

/**
 * 浮层面卡片的开与关。**只有常驻帧管这件事**：卡片自身被卸载时无从表现，而"该不该出现"
 * 取决于会前那 30 分钟，那是常驻帧的时钟。
 */
async function syncSurfaceCard(nowMs) {
  if (mountInfo.slot !== 'background') return;
  if (!can('pet.surface') || !serves('surface.show') || !serves('surface.hide')) return;
  const want = Boolean(reminderCardTarget(nowMs));
  if (want === surfaceVisible) return;
  try {
    if (want) await request('surface.show', {});
    else await request('surface.hide', {});
    surfaceVisible = want;
  } catch {
  }
}


function serveToday() {
  const nowMs = Date.now();
  return Object.assign({ events: feedToday(nowMs).map(feedEventPayload) }, feedMetaForCall(nowMs));
}

function serveNext() {
  const nowMs = Date.now();
  const event = feedNext(nowMs);
  return Object.assign({ event: event ? feedEventPayload(event) : null }, feedMetaForCall(nowMs));
}

function serveAgenda(payload) {
  const nowMs = Date.now();
  const input = payload || {};
  const events = feedAgenda(input.from, input.to, nowMs).map(feedEventPayload);
  return Object.assign({ events }, feedMetaForCall(nowMs));
}


function paintUnauthorized() {
  const missing = [];
  if (!can('storage')) missing.push('storage（缓存与提醒记录）');
  if (!can('plugin.config')) missing.push('plugin.config（订阅地址）');
  const note = '未获授权：' + missing.join('、') + '。在控制中心的「插件」页补上授权，然后重开这一面。';
  for (const node of [els.boot, els.wsState, els.wsCache, els.sfEmpty]) textOf(node, note);
  textOf(els.sfState, '未获授权');
  show(els.boot, true);
  show(els.sfMain, false);
  show(els.sfEmpty, isSurfaceMount());
  for (const node of [els.wsDays, els.wsNeedUrl, els.wsEmpty]) show(node, false);
}

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达。
window.addEventListener('message', onMessage);
postToHost({ type: 'ready' });
