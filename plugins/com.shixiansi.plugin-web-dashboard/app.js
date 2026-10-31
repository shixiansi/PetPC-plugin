// app.js —— 入口：宿主消息泵、启动接线、测试接缝

'use strict';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '插件请求失败'));
}

function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  postCallResult(ticket, false, new Error('看板插件不回答方法（它只读别人的 stats）'));
}

function postCallResult(ticket, ok, value) {
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

let refreshTimer = null;

function onInit(payload) {
  self = {
    pluginId: payload.pluginId || '',
    slot: (payload.surface && payload.surface.slot) || '',
  };
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  applyTheme(payload.theme);
  ready = true;

  if (self.slot === 'workshop') {
    if (els.workshop) els.workshop.classList.remove('hidden');
    void (async () => {
      await refreshCfg();
      await renderCards();
      renderStatus();
    })();
    refreshTimer = setInterval(() => {
      void refreshNow();
    }, Math.max(10, num('refreshSec', 10, 3600, 30)) * 1000);
    return;
  }

  // 常驻帧：周期采集（桥从插件的 storage 读 last-data 提供浏览器端）。
  // 第一拍等一个刷新周期再跑：启动时立刻向外发 plugin.call，在"对方还没起来"的
  // 情况下只会白跑一次，还会把启动链拖长。
  if (els.root) els.root.classList.add('view-background');
  void (async () => {
    await refreshCfg();
    refreshTimer = setInterval(() => {
      void collectOnce().catch(() => {});
    }, Math.max(10, num('refreshSec', 10, 3600, 30)) * 1000);
  })();
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      onInit(data);
      break;
    case 'theme':
      applyTheme(data.theme);
      break;
    case 'response':
      onResponse(data);
      break;
    case 'call':
      onCall(data);
      break;
    default:
      break;
  }
}

window.addEventListener('message', onMessage);
if (els.refreshNow) els.refreshNow.addEventListener('click', () => void refreshNow());
if (els.cmdPauseTodo) els.cmdPauseTodo.addEventListener('click', () => void sendPomodoroCommand('pause'));
if (els.cmdSayHi) els.cmdSayHi.addEventListener('click', () => void sayHi());
postToHost({ type: 'ready' });

/** 测试接缝。 */
window.__dash = Object.freeze({
  state: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    lastData,
    lastError,
  }),
  collectOnce,
  loadLastData,
  renderCards,
  renderStatus,
  barChart,
  cardText,
  askPlugin,
  sendPomodoroCommand,
  sayHi,
  refreshNow,
  refreshCfg,
  setCfg: (patch) => { cfg = Object.assign({}, cfg, patch); },
  DATA_KEY_FOR_BRIDGE,
});
