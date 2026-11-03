// app.js —— 入口：宿主消息泵、启动接线、测试接缝。
//
// 这个插件不 serves 任何方法（它不问别的插件、也不回答别人），所以没有 call 分支——
// 但协议要求对每条收到的 call 都回一条 call-result（手册 §6.8），这里照做，回一句"我不回答"。

'use strict';

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return; // 过期或未知的 id：丢掉，不要报错
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '宿主拒绝了这次调用'));
}

function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  postToHost({
    type: 'call-result',
    ticket: ticket,
    ok: false,
    error: 'GitHub 通知不回答任何方法（它只读 api.github.com）',
  });
}

function onInit(data) {
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  const surface = data.surface || {};
  const host = data.host || null;
  hostMethods = host && Array.isArray(host.methods) ? host.methods.slice() : null;
  self.pluginId = String(data.pluginId || '');
  self.slot = String(surface.slot || '');
  // 判断"我在哪个窗口"优先用 host.program，退化时才是 slot（手册 §5.2.1）。
  const program = (host && host.program) || (self.slot === 'workshop' ? 'workshop' : 'pet');
  role = program === 'workshop' ? 'page' : 'pet';
  if (data.theme) applyTheme(data.theme);
  ready = true;

  if (els.root) els.root.dataset.slot = role;
  if (role === 'page') {
    if (els.page) els.page.hidden = false;
    say('已就绪：正在读设置…');
    void bootPage();
    return;
  }
  // 桌宠侧：不画任何东西，只轮询与通知。今天的 manifest 不会挂出这个帧，但这条分支是真的
  // ——将来给这个插件加一块浮层面或常驻帧时，徽标与气泡就自动开始工作。
  void bootPet();
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
      // 宿主以后会加消息类型；不认识的一律忽略，抛错就是"宿主升级把插件弄坏"。
      break;
  }
}

window.addEventListener('message', onMessage);

if (els.btnCheck) els.btnCheck.addEventListener('click', () => void checkNow());
if (els.btnRead) {
  els.btnRead.addEventListener('click', async () => {
    await markAllRead();
    if (role === 'page') {
      paintList(els.unreadList, els.unreadEmpty, []);
      paintChips(0, nowMs());
      paintErrors([]);
      say('未读都清掉了。');
    }
  });
}

/**
 * 测试接缝：真实现都在这里，测试直接驱动它，读写照样过宿主的闸门。
 *
 * 之所以留它，是因为这个插件的核心行为（去重、304、三种 HTTP 错误、徽标只在变化时推）
 * 全都发生在"一轮 runCheck"里，而不是某个按钮上。
 */
window.__gh = Object.freeze({
  check: () => checkNow(),
  run: () => runCheck(),
  markAllRead: () => markAllRead(),
  intervalMinutes: () => intervalMinutes(),
  summarize: (items) => summarize(items),
  parseRepos: (text) => parseRepos(text),
  snapshot: () => ({
    role: role,
    ready: ready,
    slot: self.slot,
    granted: [...granted],
    cfg: Object.assign({}, cfg),
    lastBadge: lastBadge,
    conditionalOff: conditionalOff,
    polling: pollTimer !== 0,
  }),
});

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达。
postToHost({ type: 'ready' });
