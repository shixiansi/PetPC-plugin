// app.js —— 入口：宿主消息泵、plugin.call 的应答、启动接线
//
// 与 diary / agent-worker 的 app.js 同一型：四种入站（init / response / event / call）。
// background 帧负责启动时抓取配置里的远程文档并随时答 ask_kb。

'use strict';

/**
 * `plugin.call` 能问的方法。**必须与 manifest 的 `serves` 逐字相同**。
 */
const CALL_HANDLERS = {
  ask_kb: handleAskKb,
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
      `知识库不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
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
    .then(async () => {
      if (self.slot === 'workshop') {
        if (els.ask) els.ask.disabled = true;
        if (els.fetchNow) els.fetchNow.disabled = true;
        if (els.workshop) {
          const note = els.workshop.querySelector('.desktop-only');
          if (note) note.classList.remove('hidden');
        }
        void renderDocs().catch(() => {});
        // 桌宠那边的常驻帧在写同一批文件，这一面自己刷新。
        setInterval(() => {
          void renderDocs().catch(() => {});
        }, 5000);
        return;
      }
      // 桌宠的常驻帧：启动时抓一次配置里的远程文档（新增/变化的文档按新 id 入库）。
      if (els.root) els.root.classList.add('view-background');
      if (granted.has('net.fetch')) {
        void fetchRemoteDocuments().catch(() => {});
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
if (els.docAdd) els.docAdd.addEventListener('click', () => void addPastedDocument().catch(() => {}));
if (els.fetchNow) els.fetchNow.addEventListener('click', () => void fetchRemote().catch(() => {}));
if (els.ask) els.ask.addEventListener('click', () => void runAsk().catch(() => {}));
if (els.question) {
  els.question.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runAsk().catch(() => {});
    }
  });
}

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });

/** 测试接缝：切片与检索是纯函数；问答与入库走真实桥。 */
window.__kb = Object.freeze({
  handleAskKb,
  addDocument,
  removeDocument,
  fetchRemoteDocuments,
  renderDocs,
  runAsk,
  addPastedDocument,
  handlers: CALL_HANDLERS,
  chunker: { chunkDocument, cleanChunkParams, stripMarkdownNoise, makeDocId, docKey },
  index: { tokenize, termFrequencies, search, indexDocument, loadIndex, queryTerms },
  qa: { buildContext, cleanAskPayload, KB_SYSTEM, CONTEXT_BUDGET },
  snapshot: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
  }),
});
