// app.js —— 入口：宿主消息泵、启动接线、测试接缝
//
// 最后加载的一支脚本。别的模块只定义函数，真正的"开始干活"在这里。
'use strict';

// --- message pump ------------------------------------------------------------

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;
  pending.delete(data.id);
  if (data.ok) {
    waiter.resolve(data.result);
  } else {
    waiter.reject(new Error(data.error || '插件请求失败'));
  }
}

function onEvent(data) {
  if (!data || typeof data.name !== 'string') return;
  switch (data.name) {
    case 'ws.message':
      if (view === 'background' && data.payload && typeof data.payload.text === 'string') {
        onSocketFrame(data.payload.text);
      }
      break;
    case 'ws.state':
      if (view === 'background') onSocketState(data.payload);
      break;
    default:
      break;
  }
}

function onInit(payload) {
  self = { pluginId: payload.pluginId || '', surface: payload.surface || {} };
  applyTheme(payload.theme);
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  const slot = (self.surface && self.surface.slot) || '';
  view = slot === 'background' ? 'background' : 'workshop';
  els.root.classList.toggle('view-background', view === 'background');

  if (view === 'background') {
    // 常驻帧：配置齐了才起机器人；缺配置或没授权时留在 error 状态，工坊页会显示原因。
    // 注意 ensureConfig() 必须在 init 之后调：granted 是这一步才有的。
    void ensureConfig().catch(() => {}).then(() => {
      if (!String(cfg.appId || '').trim()) {
        renderState('error', { reason: '还没有配置 AppID / AppSecret' });
        return;
      }
      if (!granted.has('net.ws') || !granted.has('net.fetch')) {
        renderState('error', { reason: '缺少 net.ws / net.fetch 授权，机器人无法连接官方网关' });
        return;
      }
      startBot();
    });
    return;
  }
  bindWorkshop();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
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
    default:
      break;
  }
}

window.addEventListener('message', onMessage);
postToHost({ type: 'ready' });

/**
 * 测试接缝：把一帧网关文本、当前配置视图和内部状态暴露给测试。
 * 一切仍然走 request / 宿主的权限闸门，这里只是少等真实的时间。
 */
window.__qqbot = Object.freeze({
  onSocketFrame,
  onSocketState,
  handleEventType,
  normalizeEvent,
  shouldReply,
  intentsFor,
  seenBefore,
  nextSeq,
  state: {
    get cfg() { return cfg; },
    get gw() { return gw; },
    get token() { return token; },
  },
});
