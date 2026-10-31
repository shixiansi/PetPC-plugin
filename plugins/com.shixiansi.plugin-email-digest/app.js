// app.js —— 入口：宿主消息泵、定时器、启动接线、测试接缝
//
// 常驻帧负责两件事：读设置、每分钟看一次钟（autoTick：到 digestTime 且今天还没跑过
// 就自动推送）。工坊页显示最近一批的分类结果与历史。

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

function onEvent(data) {
  if (!data || typeof data.name !== 'string') return;
  // config.changed 是广播：别的插件改配置也会推过来，按 pluginId 过滤。
  if (data.name === 'config.changed' && data.payload && data.payload.pluginId === self.pluginId) {
    void refreshCfg();
  }
}

function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  postCallResult(ticket, false, new Error('邮件摘要插件不回答方法（它只调用记忆核心）'));
}

function postCallResult(ticket, ok, value) {
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

let clockTimer = null;

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
      renderWorkshop();
      await renderLog();
    })();
    setInterval(() => {
      void (async () => {
        await refreshCfg();
        renderWorkshop();
      })();
    }, 5000);
    return;
  }

  // 常驻帧：读设置、订阅配置变更、启动时钟。
  if (els.root) els.root.classList.add('view-background');
  void (async () => {
    await refreshCfg();
    if (granted.has('events')) {
      await request('events.subscribe', { names: ['config.changed'] }).catch(() => {});
    }
    if (!clockTimer) {
      clockTimer = setInterval(() => {
        void autoTick().catch(() => {});
      }, 60000);
    }
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
    case 'event':
      onEvent(data);
      break;
    case 'call':
      onCall(data);
      break;
    default:
      break;
  }
}

window.addEventListener('message', onMessage);
if (els.digestNow) els.digestNow.addEventListener('click', () => void digestButton());
postToHost({ type: 'ready' });

/** 测试接缝。 */
window.__mail = Object.freeze({
  mime: MimeParser,
  state: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    ...digestSnapshot(),
  }),
  fetchUnread,
  localSpam,
  classifyBatch,
  parseClassify,
  digestOnce,
  deliver,
  speak,
  autoTick,
  loadLog,
  renderWorkshop,
  refreshCfg,
  setCfg: (patch) => { cfg = Object.assign({}, cfg, patch); },
});
