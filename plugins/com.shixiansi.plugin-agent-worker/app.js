// app.js —— 入口：宿主消息泵、plugin.call 的应答、启动接线
//
// 与 diary 的 app.js 同一型：四种入站（init / response / event / call）。
// background 帧负责 5 分钟一次的队列检查与随时答问。

'use strict';

/**
 * `plugin.call` 能问的方法。**必须与 manifest 的 `serves` 逐字相同**。
 */
const CALL_HANDLERS = {
  add_background_task: handleAddBackgroundTask,
  queue_status: handleQueueStatus,
};

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '插件请求失败'));
}

/** 答一次 plugin.call。三种结局都要回 call-result——包括「我不认识这个方法」。 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `后台任务执行器不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

/** add_background_task：入队并立刻答回（执行是后台的事）。 */
async function handleAddBackgroundTask(payload) {
  const out = await enqueueTask(payload, { maxTasks: num('maxTasks', 1, 50, 20) });
  return { id: out.id, queueLength: out.queueLength };
}

/** queue_status：队列摘要（别的插件/面板查看进度）。 */
async function handleQueueStatus() {
  const tasks = await loadTasks();
  return summarize(tasks);
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
    .then(async () => {
      if (self.slot === 'workshop') {
        if (els.runOnce) els.runOnce.disabled = true;
        if (els.workshop) {
          const note = els.workshop.querySelector('.desktop-only');
          if (note) note.classList.remove('hidden');
        }
        void renderQueue().catch(() => {});
        setInterval(() => {
          void renderQueue().catch(() => {});
        }, 5000);
        return;
      }
      // 桌宠的常驻帧：断点恢复 + 定时检查。
      if (els.root) els.root.classList.add('view-background');
      if (granted.has('plugin.call')) {
        const recovered = await recoverOrphans();
        if (recovered) {
          say(`恢复了 ${recovered} 个被重启中断的任务`);
          await announce(`主人，重启后有 ${recovered} 个后台任务被中断了，我会继续把它们跑完。`);
        }
        startPolling();
      } else {
        say('未获授权：plugin.call（队列不会执行）');
      }
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
    case 'call':
      void onCall(data);
      break;
    default:
      // `event` / `surface` / 未知类型：忽略是协议要求的宽容。
      break;
  }
}

window.addEventListener('message', onMessage);
if (els.submit) els.submit.addEventListener('click', () => void submitTask().catch(() => {}));
if (els.taskText) {
  els.taskText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitTask().catch(() => {});
    }
  });
}
if (els.runOnce) els.runOnce.addEventListener('click', () => void runOnce().catch(() => {}));

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });

/** 测试接缝：队列的执行发生在看不见的那一面。 */
window.__agent = Object.freeze({
  runOneTask,
  drainQueue,
  pollTick,
  startPolling,
  stopPolling,
  recoverOrphans,
  enqueueTask,
  renderQueue,
  submitTask,
  handlers: CALL_HANDLERS,
  queue: { loadTasks, pickNextTask, markRunning, markDone, markFailed, summarize, cleanTaskPayload, MAX_ATTEMPTS },
  runner: { executeTask, publishStatus, announce, SHARE_STATUS },
  snapshot: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
  }),
});
