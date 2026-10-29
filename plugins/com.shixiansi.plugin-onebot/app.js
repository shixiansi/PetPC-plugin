// app.js —— 入口：宿主消息泵、连接生命周期、启动接线
//
// 常驻帧（slot: 'background'）是这个插件的全部：它拥有那条连接，收到一帧就处理一帧。
// 插件页（slot: 'workshop'）只是同一份文件的另一副面孔，只读状态、不碰连接。
//
// 连接的生命周期归**宿主**：ws.open 之后，宿主负责重连与 30 秒心跳，状态变化以
// `ws.state` 事件推过来。所以这里不做重连（那会是第二份重连策略，两份必然打架），只在
// init 时开一次，并把状态如实显示出来。

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
  switch (data.name) {
    case 'ws.message':
      if (self.slot === 'background' && data.payload && typeof data.payload.text === 'string') {
        void onSocketFrame(data.payload.text).catch((err) => {
          note(`处理一帧失败：${text(err && err.message, 160)}`);
        });
      }
      break;
    case 'ws.state':
      if (self.slot === 'background' && data.payload) {
        wsState = typeof data.payload.state === 'string' ? data.payload.state : wsState;
        renderStatus();
        if (wsState === 'open') void learnSelf().catch(() => {});
        if (wsState === 'error') {
          note(`连接出错：${text(data.payload.error, 160)}`);
        }
      }
      break;
    default:
      // llm.* 那一类永远不会到这里：这个插件不调模型。
      break;
  }
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

  void refreshConfig()
    .then(() => {
      renderStatus();
      if (self.slot === 'workshop') {
        void renderWorkshop().catch((err) => say(`刷新失败：${text(err && err.message, 120)}`));
        setInterval(() => {
          void renderWorkshop().catch(() => {});
        }, 5000);
        return;
      }
      // 常驻帧：不画东西，只连上去。
      if (els.root) els.root.classList.add('view-background');
      if (!granted.has('net.ws')) {
        note('没有 net.ws 权限，连不上协议端（在插件设置里重新授权）');
        return;
      }
      // 每一条"射后不理"的 promise 都要有 catch：一条没有接收者的 rejection 会以
      // "未处理的 promise 拒绝" 收尾，而它的原因（比如 storage 未授权）就看不见了。
      void openSocket().catch((err) => note(`连接流程失败：${text(err && err.message, 160)}`));
    })
    .catch(() => {});
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
      // 这个插件不答 plugin.call（manifest 里没有 serves），也不订阅 surface 变化。
      break;
  }
}

window.addEventListener('message', onMessage);
postToHost({ type: 'ready' });

/**
 * 测试接缝：一帧入站、一次连接、以及当前的内部状态。
 *
 * 这个插件的正确性有一半在"这一帧该不该接"的判断上，而那件事只能从外面喂帧来验证。
 * 下面每一项仍然经 `request` 走宿主闸门，所以它不是一条额外的能力。
 */
window.__onebot = Object.freeze({
  frame: onSocketFrame,
  connect: openSocket,
  learnSelf,
  snapshot: () => ({ slot: self.slot, wsState, selfId, cfg: { ...cfg }, seen: seenIds.size }),
});
