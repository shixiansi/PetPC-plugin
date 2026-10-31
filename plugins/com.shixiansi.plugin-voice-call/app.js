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
  postCallResult(ticket, false, new Error('语音通话插件不回答方法（它只调用记忆核心）'));
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
    void (async () => {
      await refreshCfg();
      renderWorkshop();
    })();
    setInterval(() => {
      void (async () => {
        await refreshCfg();
        renderWorkshop();
      })();
    }, 5000);
    return;
  }

  // 常驻帧：读设置 → 按开关进入监听。
  if (els.root) els.root.classList.add('view-background');
  void (async () => {
    await refreshCfg();
    if (flag('callEnabled', false)) {
      startCall();
      startFrameTimer();
    }
    // 15 秒兜底：宿主会为 share.changed 发事件（手册 §7.1），这个定时器只负责"事件丢了"。
    setInterval(() => {
      void pollCommand();
    }, 15000);
  })();
}

/**
 * 宿主说"你关心的共享键变了"（share.changed，手册 §7.1）：立刻读一次，不用等 15 秒兜底。
 *
 * 只认自己名下的键（`<自己的 id>/<名字>`）：命令键是同一个插件的两个帧之间的通道，
 * 而这条事件也会因为"别人的键变了"送到这里——那不是给我们的。
 */
function onHostEvent(data) {
  if (!data || data.name !== 'share.changed') return;
  const payload = data.payload || {};
  const key = String(payload.key || '');
  if (!self.pluginId || !key.startsWith(self.pluginId + '/')) return;
  void pollCommand();
}
function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      onInit(data);
      break;
    case 'event':
      onHostEvent(data);
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
if (els.callToggle) els.callToggle.addEventListener('click', () => void toggleButton());
postToHost({ type: 'ready' });

/** 测试接缝：状态机与整条链路都可以直接驱动。 */
window.__call = Object.freeze({
  vad: { create: VadMachine.create, step: VadMachine.step, stepInterrupt: VadMachine.stepInterrupt, finishSend: VadMachine.finishSend, levelOf: VadMachine.levelOf },
  state: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    ...callSnapshot(),
  }),
  startCall,
  stopCall,
  pollFrame,
  handleEvents,
  processUtterance,
  transcribe,
  askModel,
  speakAnswer,
  pollCommand,
  renderWorkshop,
  refreshCfg,
  setCfg: (patch) => { cfg = Object.assign({}, cfg, patch); },
});
