// app.js —— 记忆卡片：入口、协议泵、复习会话、到期提醒、plugin.call 应答
//
// 一个文档，两种身份：
//
//   workshop    控制中心插件页：复习会话（翻转 + 四键评分）、建卡/导入、卡组管理。
//   background  桌宠常驻帧：每 5 分钟看一次到期数 → 到期 > 0 且开启提醒时 bubble.say
//               （同一天最多提醒 3 次，别把桌宠变成闹钟流氓）；答 plugin.call。
//
// 写者唯一：deck 只被本文件写；workshop 与 background 都经这里。

'use strict';

const V = 1;
const HOST = window.parent;
let nextId = 1;
const pending = new Map();

const PERM = {
  storage: 'storage',
  config: 'plugin.config',
  call: 'plugin.call',
  share: 'plugin.share',
  bubble: 'pet.bubble',
};

function request(method, payload) {
  const id = `r${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload ?? {} }, '*');
  });
}

let granted = new Set();
let self = { pluginId: '', slot: '' };
let cfg = {};
let deck = [];
// 会话状态机：idle → card(revealed?) → … → done
let session = { active: false, queue: [], index: 0, revealed: false, done: 0 };
let reminder = { day: '', count: 0 };
let tickTimer = null;

window.addEventListener('message', (event) => {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;
  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    case 'call':
      void onCall(data);
      break;
    default:
      break;
  }
});

// --- 存取 ------------------------------------------------------------------------

async function loadDeck() {
  if (!granted.has(PERM.storage)) return;
  try {
    const out = await request('storage.get', { key: FlashDeck.DECK_KEY });
    if (out && out.value) {
      const parsed = JSON.parse(out.value);
      if (Array.isArray(parsed)) deck = parsed;
    }
  } catch {
    deck = [];
  }
}

async function persistDeck() {
  if (!granted.has(PERM.storage)) return;
  try {
    await request('storage.set', { key: FlashDeck.DECK_KEY, value: JSON.stringify(deck) });
  } catch {
    // 存不下：内存里继续。
  }
}

// --- 复习会话 ---------------------------------------------------------------------

function startSession(now = Date.now()) {
  const due = FlashDeck.deckDueCards(deck, now, 50);
  if (!due.length) {
    if (self.slot === 'workshop') FlashcardsWorkshop.fwsSetStatus('没有到期的卡片，稍后再来。');
    return false;
  }
  session = { active: true, queue: due, index: 0, revealed: false, done: 0 };
  if (self.slot === 'workshop') {
    FlashcardsWorkshop.fwsRenderReviewVisibility(true);
    FlashcardsWorkshop.fwsRenderCurrentCard(session.queue[0], false, 0, session.queue.length);
  }
  return true;
}

function revealCard() {
  if (!session.active || session.revealed) return;
  session.revealed = true;
  if (self.slot === 'workshop') {
    FlashcardsWorkshop.fwsRenderCurrentCard(session.queue[session.index], true, session.index, session.queue.length);
  }
}

/** 评分：SM-2 结算 → 写回卡组 → 下一张 / 完成。 */
async function gradeCard(grade, now = Date.now()) {
  if (!session.active) return null;
  if (grade !== 'forget' && grade !== 'hard' && grade !== 'good' && grade !== 'easy') {
    throw new Error(`未知评分 ${grade}`);
  }
  const card = session.queue[session.index];
  if (!card) return null;
  const reviewed = FlashDeck.deckReview(card, grade, now);
  deck = FlashDeck.deckApplyReview(deck, card.id, reviewed);
  await persistDeck();
  session.done += 1;
  session.index += 1;
  session.revealed = false;
  if (session.index >= session.queue.length) {
    session.active = false;
    if (self.slot === 'workshop') {
      FlashcardsWorkshop.fwsRenderSessionDone(session.done, session.queue.length);
      FlashcardsWorkshop.fwsRenderDeck(deck, now, (id) => void deleteCard(id));
    }
    return { finished: true, done: session.done };
  }
  if (self.slot === 'workshop') {
    FlashcardsWorkshop.fwsRenderCurrentCard(session.queue[session.index], false, session.index, session.queue.length);
  }
  return { finished: false, done: session.done };
}

// --- 到期提醒（background 帧） -----------------------------------------------------

function todayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function reminderTick(now = Date.now()) {
  if (cfg.remindOnDue === 'false') return;
  if (!granted.has(PERM.bubble)) return;
  const day = todayKey(now);
  if (reminder.day !== day) reminder = { day, count: 0 };
  if (reminder.count >= (Number(cfg.remindPerDay) || 3)) return;
  const due = FlashDeck.deckDueCards(deck, now).length;
  if (due <= 0) return;
  reminder.count += 1;
  try {
    await request('bubble.say', { text: `有 ${due} 张卡片到期啦，趁热复习一下？` });
  } catch {
    // 气泡失败不打扰。
  }
}

function startReminderLoop() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => void reminderTick(), 5 * 60 * 1000);
  setTimeout(() => void reminderTick(), 4000);
}

// --- plugin.call ----------------------------------------------------------------

const CALL_HANDLERS = {
  /** 到期统计（别的插件想知道"现在该不该提醒"）。 */
  due_stats: async () => {
    const stats = FlashDeck.deckStats(deck, Date.now());
    const next = SM2.sm2NextDueDate(deck, Date.now());
    return { ...stats, nextDue: next };
  },
  /** 批量建卡（别的插件生成卡片：划词助手、知识库）。payload {cards:[{front,back,tags?}]} */
  add_cards: async (payload) => {
    const list = Array.isArray(payload && payload.cards) ? payload.cards : [];
    if (!list.length) throw new Error('add_cards 需要 {cards:[…]}');
    if (list.length > 100) throw new Error('一次最多建 100 张');
    let added = 0;
    const now = Date.now();
    for (const item of list) {
      const card = FlashDeck.deckMakeCard({ front: item.front, back: item.back, tags: item.tags || [] }, now);
      const out = FlashDeck.deckAdd(deck, card);
      deck = out.deck;
      if (out.added) added += 1;
    }
    await persistDeck();
    return { added, total: deck.length };
  },
  /** 导出全部（备份用）。 */
  export_deck: async () => ({ cards: deck.length, text: FlashDeck.deckExportText(deck) }),
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `记忆卡片不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

function postCallResult(ticket, ok, value) {
  const message = { v: V, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  HOST.postMessage(message, '*');
}

// --- 工坊页 ---------------------------------------------------------------------

async function runImport() {
  const ta = FlashcardsWorkshop.FWS.els && FlashcardsWorkshop.FWS.els['import-text'];
  const text = String((ta && ta.value) || '');
  if (!text.trim()) {
    FlashcardsWorkshop.fwsSetStatus('先粘贴要导入的卡片（一行一张：正面 | 背面）', 'danger');
    return;
  }
  const { cards, errors } = FlashDeck.deckImportText(text, Date.now());
  let added = 0;
  for (const card of cards) {
    const out = FlashDeck.deckAdd(deck, card);
    deck = out.deck;
    if (out.added) added += 1;
  }
  await persistDeck();
  FlashcardsWorkshop.fwsRenderImportReport({ added, errors, total: cards.length });
  renderDeck();
}

async function deleteCard(id) {
  deck = FlashDeck.deckRemove(deck, id);
  await persistDeck();
  renderDeck();
}

function renderDeck() {
  if (self.slot !== 'workshop') return;
  FlashcardsWorkshop.fwsRenderDeck(deck, Date.now(), (id) => void deleteCard(id));
}

async function onInit(data) {
  self = {
    pluginId: data.pluginId || '',
    slot: (data.surface && data.surface.slot) || '',
  };
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';

  if (granted.has(PERM.config)) {
    try {
      const out = await request('config.get', {});
      cfg = Object.assign({}, (out && out.values) || {});
    } catch { cfg = {}; }
  }

  await loadDeck();

  if (self.slot !== 'workshop') {
    startReminderLoop();
    return;
  }

  FlashcardsWorkshop.fwsCollectEls();
  FlashcardsWorkshop.fwsRenderReviewVisibility(false);
  FlashcardsWorkshop.fwsRenderDeck(deck, Date.now(), (id) => void deleteCard(id));
  FlashcardsWorkshop.FWS.els['review-start']?.addEventListener('click', () => startSession());
  FlashcardsWorkshop.FWS.els['card-flip']?.addEventListener('click', () => revealCard());
  FlashcardsWorkshop.FWS.els['card-flip']?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') revealCard();
  });
  for (const btn of FlashcardsWorkshop.FWS.els.grades.querySelectorAll('button[data-grade]')) {
    btn.addEventListener('click', () => void gradeCard(btn.dataset.grade));
  }
  FlashcardsWorkshop.FWS.els['import-run']?.addEventListener('click', () => void runImport());
  FlashcardsWorkshop.FWS.els['export-run']?.addEventListener('click', () => {
    const ta = FlashcardsWorkshop.FWS.els['import-text'];
    if (ta) ta.value = FlashDeck.deckExportText(deck);
    FlashcardsWorkshop.fwsSetStatus(`已导出 ${deck.length} 张到输入框，复制即可备份`);
  });
}

HOST.postMessage({ v: V, type: 'ready' }, '*');

/** 测试接缝。 */
window.__flashcards = Object.freeze({
  request,
  handlers: CALL_HANDLERS,
  startSession,
  revealCard,
  gradeCard,
  reminderTick,
  stopReminder: () => { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } },
  runImport,
  deleteCard,
  sm2: SM2,
  deck: FlashDeck,
  workshop: FlashcardsWorkshop,
  snapshot: () => ({
    slot: self.slot,
    granted: [...granted],
    cfg: { ...cfg },
    deckSize: deck.length,
    session: { ...session, queue: session.queue.map((c) => c.id) },
    reminder: { ...reminder },
  }),
});
