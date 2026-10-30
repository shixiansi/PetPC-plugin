// app.js —— 入口：宿主消息泵、启动接线
//
// 与其它插件的 app.js 同一型，但简单得多：没有 plugin.call（游戏不回答问题）、
// 没有 background（合上浮层就停）。入站只有 init / response / theme。

'use strict';

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '插件请求失败'));
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
      // surface 块是唯一的挂载。没授予 plugin.share 也能玩——只是不发布。
      if (els.play) els.play.disabled = false;
      say(flag('shareScore', true) && !granted.has('plugin.share')
        ? '未获授权：plugin.share（本局得分不会发布给桌宠生态）'
        : '');
      wireUI();
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
    default:
      // `event` / `surface` / `call`（未声明 serves 不会来）/ 未知类型：忽略是协议要求的宽容。
      break;
  }
}

window.addEventListener('message', onMessage);

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });

/** 测试接缝：渲染与输入没法在 jsdom 里排版，但状态机与发布可以驱动真实链路。 */
window.__game = Object.freeze({
  startGame,
  finishGame,
  backToMenu,
  showPanel,
  paint,
  wireUI,
  currentInput,
  handlers: {},
  snapshot: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    playing,
    phase: game ? game.getPhase() : 'menu',
    state: game ? game.getState() : null,
  }),
});
