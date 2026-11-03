// app.js —— 入口：宿主消息泵、启动接线
//
// 一个文档，两副面孔，由 init 的 surface.slot 决定：
//
//   slot:"background"（桌宠挂的那份，display:none）  拥有轮询：拉 update、问记忆核心、发回去。
//   slot:"workshop"（控制中心挂的那份）              只读的状态与设置，一个 net.fetch 都不发。
//
// 常驻帧是 display:none 的：看不见、不能点、不能滚。所以这里**不读布局、不算尺寸、不碰焦点**
// ——状态只放内存 + storage，工坊页从 storage 里读同一份。

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

/**
 * `plugin.call`：别的插件问这个管道一句话。控制中心不服务 `plugin.call`（只挂一页、没有常驻
 * 帧，另一端没人答），所以真到了那里也只会是宿主自己发的——回一句说得清的话，别让它等 30 秒。
 */
async function answerCall(method, payload) {
  switch (method) {
    case 'on_message':
      return handleOnMessage(payload);
    default:
      throw new Error(`这个插件只回答 on_message，没有 ${text(method, 40)}`);
  }
}

async function onCall(data) {
  const ticket = data.ticket;
  try {
    const result = await answerCall(data.method, data.payload);
    postToHost({ type: 'call-result', ticket, ok: true, result });
  } catch (err) {
    postToHost({ type: 'call-result', ticket, ok: false, error: String((err && err.message) || err) });
  }
}

async function bootstrapWorkshop() {
  const refresh = () => renderWorkshop().catch((err) => say(`刷新失败：${text(err && err.message, 120)}`));
  await refresh();
  if (els.refresh) els.refresh.addEventListener('click', () => void refresh());
  // 15 秒兜底：没有 `events` 权限就收不到 config.changed / storage.changed，而桌宠里那一面
  // 随时在写 state/status。1 秒是反模式（手册 §7.2 与 AGENTS §3.9）。
  setInterval(() => void renderWorkshop().catch(() => {}), 15000);
}

async function bootstrapBackground() {
  if (els.root) els.root.classList.add('view-background');
  // 缺权限也进循环：循环会把原因写进状态，工坊页据此显示"还差哪一步"。
  renderStatus();
  await pollLoop();
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
    .then(() => (self.slot === 'workshop' ? bootstrapWorkshop() : bootstrapBackground()))
    .catch((err) => note(`启动失败：${text(redact(err && err.message ? err.message : err), 160)}`));
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
      if (typeof data.ticket === 'string' && data.ticket) void onCall(data);
      break;
    default:
      // 这个插件没有浮层面，也没有订阅：surface 变化、未知 type、未来的协议版本一律忽略。
      break;
  }
}

window.addEventListener('message', onMessage);
postToHost({ type: 'ready' });

/**
 * 测试接缝：一拍、一条 update、以及当前内部状态。
 *
 * 为什么需要它：这个插件的正确性有一半是"等多久才再试一次"（15 → 30 → 60 的退避阶梯），而等
 * 15 秒在用例里没法过。`setSleep` 换掉的只是**等待**：退避怎么算仍然是被测的那段真代码。
 */
window.__telegram = Object.freeze({
  tick: pollOnce,
  inject: ingestUpdate,
  answer: handleOnMessage,
  setSleep: setPollSleep,
  stop: stopPolling,
  snapshot: () => ({
    slot: self.slot,
    phase: pollState.phase,
    message: pollState.message,
    retryIn: pollState.retryIn,
    cursor,
    backoffMs,
    answered: pollState.answered,
    skipped: pollState.skipped,
    failed: pollState.failed,
    lastError: pollState.lastError,
    token: Boolean(botToken()),
    tokenLength: botToken().length,
    poll: pollEnabled(),
    allow: chatAllowList(),
  }),
});
