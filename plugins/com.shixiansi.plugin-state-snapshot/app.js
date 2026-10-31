// app.js —— 入口：宿主消息泵、启动接线、测试接缝
//
// 这个插件不 serves 任何方法（它是 plugin.call 的提问方），所以没有 call 分支——
// 但协议要求对每条收到的 call 都回 call-result（手册 §6.8），这里照做。

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
  postCallResult(ticket, false, new Error('状态时光机不回答方法（它只调用记忆核心）'));
}

function postCallResult(ticket, ok, value) {
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

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
    void renderWorkshop().catch(() => {});
    setInterval(() => {
      void renderWorkshop().catch(() => {});
    }, 5000);
    return;
  }
  // 常驻帧：什么都不画。业务函数都在，谁 plugin.call 它就答谁——
  // 但这个插件不 serves，所以常驻帧只是"在场"。
  if (els.root) els.root.classList.add('view-background');
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
if (els.snapCreate) els.snapCreate.addEventListener('click', () => void createButton());
postToHost({ type: 'ready' });

/**
 * 测试接缝。快照的全部行为（save/list/remove/rename/rollback）都可以直接驱动；
 * 每个函数里的读写仍然经 request 过宿主的闸门。
 */
window.__snaps = Object.freeze({
  store: SnapStore,
  create: handleCreateSnapshot,
  rollback: handleRollback,
  state: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    ...snapshotSnapshot(),
  }),
  loadRollbackLog,
  renderWorkshop,
  renderTimeline,
  renderLog,
  renderStatus,
  refreshCfg,
  setCfg: (patch) => { cfg = Object.assign({}, cfg, patch); },
});
