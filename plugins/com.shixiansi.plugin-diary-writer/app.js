// app.js —— 入口：宿主消息泵、plugin.call 的应答、启动接线
//
// 与 websearch / rss-reader 的 app.js 同一型：四种入站（init / response / event / call）。
// background 帧负责 23:00 的定时写入与随时答问；workshop 页只读 + 手动触发。

'use strict';

/**
 * `plugin.call` 能问的方法。**必须与 manifest 的 `serves` 逐字相同**。
 */
const CALL_HANDLERS = {
  get_recent: handleGetRecent,
  write_now: handleWriteNow,
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
      `日记不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

/** plugin.call 的 get_recent：桌宠对话里引用最近的日记。payload {limit?}。 */
async function handleGetRecent(payload) {
  const limit = Math.min(Math.max(Number(payload && payload.limit) || 1, 1), 7);
  const entries = await loadRecentDiaries(limit);
  return {
    entries: entries.map((e) => ({ day: e.day, mood: e.mood, text: text(e.text, 600) })),
  };
}

/** plugin.call 的 write_now：立刻写一篇（面板按钮走同一条 writeDiary）。 */
async function handleWriteNow() {
  const entry = await writeDiary();
  return { day: entry.day, mood: entry.mood, text: entry.text, truncated: entry.truncated };
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
        if (els.writeNow) els.writeNow.disabled = true;
        if (els.workshop) {
          const note = els.workshop.querySelector('.desktop-only');
          if (note) note.classList.remove('hidden');
        }
        void renderDiaries().catch(() => {});
        // 桌宠那边的常驻帧在写同一批文件，这一面自己刷新。
        setInterval(() => {
          void renderDiaries().catch(() => {});
        }, 5000);
        return;
      }
      // 桌宠的常驻帧：定时器在这里跑。
      if (els.root) els.root.classList.add('view-background');
      if (granted.has('plugin.call')) {
        scheduleDiary();
        // 启动时补一次判定（宿主半夜重启错过点的话）：diaryTick 自己会检查"今天写过没"。
        void diaryTick().catch(() => {});
      } else {
        say('未获授权：plugin.call（定时写日记不会运行）');
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
if (els.writeNow) els.writeNow.addEventListener('click', () => void runWriteNow().catch(() => {}));

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });

/** 测试接缝：定时与聚合都发生在看不见的那一面。 */
window.__diary = Object.freeze({
  writeDiary,
  diaryTick,
  scheduleDiary,
  stopDiaryTimer,
  renderDiaries,
  runWriteNow,
  handlers: CALL_HANDLERS,
  collect: { collectToday, eventsTodayFromSnapshot, summarizeEvents, todosFromSnapshot, countFocusToday, readShared, dayKeyOf, yesterdayKey, msUntilNext, parseDiaryTime },
  diary: { parseDiaryJSON, buildPrompt, loadRecentDiaries, diaryKey, pruneOldDiaries, moodLabel, PROMPT_BUDGET, MOODS, DIARY_SYSTEM },
  snapshot: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
  }),
});
