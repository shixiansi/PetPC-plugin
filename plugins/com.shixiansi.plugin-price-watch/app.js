// app.js —— 握手 + 两副面孔的接线
//
//   常驻帧（slot: background，桌宠挂的）：display:none，只做三件事——按间隔抓取、比对内容指纹、
//     「变了才说一句」，逻辑在 `lib/watch.js`。
//   插件页（slot: workshop，控制中心挂的）：只展示与设置，逻辑在 `lib/workshop.js`。
//
// 为什么这么分（手册 §9）：`bubble.say` 只在桌宠程序里被服务，控制中心的插件页没有宠物窗口——
// 所以「变了说一句」必须由常驻帧做。这个插件不声明 `surface`（不占宠物旁边的位置），也不声明
// `serves`（不答 plugin.call）。

'use strict';

/** 插件页的兜底刷新间隔：主路径是 `storage.changed`（两个宿主都发），15 秒只是兜底。 */
const PAGE_FALLBACK_MS = 15000;

let pageTimer = null;

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return; // 过期或未知的 id：丢掉，不要报错
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '宿主拒绝了这次调用'));
}

/**
 * 常驻帧：先读一次设置，再决定排不排计时器。三个前置条件都必须在排计时器**之前**满足，否则
 * "抓取"只会变成一条注定被拒的请求：`granted` 缺 `net.fetch`/`storage`/`plugin.config`；这个窗口
 * 不服务 `net.fetch`；或者一条条目都没配好。第三条最要紧：**未配置时不发任何请求**。
 */
async function startBackgroundFrame() {
  if (els.root) els.root.classList.add('view-background');
  const missing = ['net.fetch', 'storage', 'plugin.config'].filter((name) => !granted.has(name));
  if (missing.length) {
    say(`未获授权：${missing.join('、')}（监控不会运行）`);
    return;
  }
  if (!hostServes('net.fetch')) {
    say('这个窗口不服务 net.fetch：抓取只能在桌宠里跑');
    return;
  }
  try {
    await refreshConfig();
  } catch (err) {
    say(errorText(err));
    return;
  }
  if (!watchableEntries(parseEntries(cfg.entries)).length) {
    say('还没有配置监控条目：配好之前不会抓任何东西');
    return;
  }
  schedule(FIRST_DELAY_MS);
}

/** 插件页：画一屏，然后等 `storage.changed`（主路径）与 15 秒兜底。 */
function startWorkshopFrame() {
  if (els.workshop) els.workshop.classList.remove('hidden');
  if (els.root) els.root.classList.remove('view-background');
  void renderWorkshop().catch(() => {});
  if (pageTimer === null) {
    pageTimer = setInterval(() => void renderWorkshop().catch(() => {}), PAGE_FALLBACK_MS);
  }
}

/**
 * 事件。两个宿主都会发 `storage.changed` / `config.changed`，但含义不同：
 *
 *   常驻帧  `cmd/reload` 是插件页写来的"设置变了"信标 → 重排计时器；`config.changed` 是真有人改
 *           了磁盘上的 config.json → 同样重排。
 *   插件页  快照/历史的变动都要重画；`config.changed` 还要把信标写给桌宠那一侧，因为**改设置的
 *           地方在控制中心**，而抓取的计时器在桌宠进程里。
 */
function onHostEvent(name, payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const inWorkshop = self.slot === 'workshop';
  if (name === 'storage.changed') {
    if (!inWorkshop) {
      onStorageChanged(data.key);
      return;
    }
    // 自己写的那条信标也会回到自己（宿主不给写者开小灶），重画一次无害，但没必要。
    if (String(data.key || '') !== BEACON_KEY) void renderWorkshop().catch(() => {});
    return;
  }
  if (name !== 'config.changed') return;
  // payload.pluginId 是给订阅了所有插件的桌宠用的；两边都认同一个判据。
  if (data.pluginId && self.pluginId && data.pluginId !== self.pluginId) return;
  if (inWorkshop) {
    void renderWorkshop().catch(() => {});
    void writeReloadBeacon().catch(() => {});
    return;
  }
  void reloadAndReschedule().catch(() => {});
}

function onInit(payload) {
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  hostMethods = payload.host && Array.isArray(payload.host.methods) ? payload.host.methods.slice() : null;
  const surface = payload.surface || {};
  const program = (payload.host && payload.host.program) || (surface.slot === 'workshop' ? 'workshop' : 'pet');
  self = { pluginId: String(payload.pluginId || ''), slot: String(surface.slot || ''), program: String(program) };
  if (payload.theme) applyTheme(payload.theme);
  ready = true;
  // 判据只有 `slot`：常驻帧与面板的 kind 都是 'panel'（手册 §5.2）。
  if (self.slot === 'workshop') startWorkshopFrame();
  else void startBackgroundFrame().catch(() => {});
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  // 不认识的 type（`surface` / `call` / 未来的新消息）忽略即可——那是协议要求的宽容。
  if (data.type === 'init') onInit(data);
  else if (data.type === 'theme') applyTheme(data.theme);
  else if (data.type === 'response') onResponse(data);
  else if (data.type === 'event') onHostEvent(String(data.name || ''), data.payload);
}

window.addEventListener('message', onMessage);
if (els.refresh) els.refresh.addEventListener('click', () => void renderWorkshop().catch(() => {}));

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });

/**
 * 测试接缝：这个插件的行为一半发生在看不见的那一面（常驻帧的计时器、一轮抓取里的六次判断），
 * 测试要么驱动真实链路，要么只能读源码假装它是对的。所以点出"链路的入口"，而不是暴露可写字段。
 */
window.__priceWatch = Object.freeze({
  runCycle, schedule, stopTimer, reloadAndReschedule, writeReloadBeacon, onStorageChanged,
  renderWorkshop, parseEntries, extractContent, normalizeText, snippetAround, hashText,
  isQuietAt, intervalMs, statusOf, loadSnapshot, loadHistory,
  snapshot: () => ({ ...watchState(), slot: self.slot, ready, granted: [...granted] }),
});
