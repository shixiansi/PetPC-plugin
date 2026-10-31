// lib/deck.js —— 卡组管理：建卡（Markdown）、到期队列、复习会话（纯逻辑，注入时钟）
//
// 卡片形状：
//   { id, front, back, tags:[], ef, interval, repetitions, due, createdAt, reps, lapses }
//   front/back 是 Markdown 源文本（面板里用极简渲染：加粗/斜体/代码/换行）。
//
// 会话（review session）是一次"到期卡片按序复习"的状态机：
//   idle → showing-front → showing-back → (grade) → 下一张 / 完成
// 调度（什么时候弹提醒）由 background 帧的内部定时器做：每 5 分钟看一次
// dueCount，> 0 且提醒开关开 → bubble.say。

'use strict';

const DECK_KEY = 'deck-v1';
const SESSION_KEY = 'session-v1';
const DECK_MAX = 2000;

/** 稳定 id（front 的 djb2 + 随机尾巴，重名卡不合并——同一段文字建两张是合法需求）。 */
function deckMakeId(front, now = Date.now()) {
  let h = 5381;
  for (let i = 0; i < front.length; i += 1) h = ((h << 5) + h + front.charCodeAt(i)) | 0;
  return `c${(h >>> 0).toString(36)}${(now % 1e6).toString(36)}`;
}

/** 新卡（到期即现在）。 */
function deckMakeCard({ front, back, tags }, now = Date.now()) {
  const f = String(front || '').trim();
  const b = String(back || '').trim();
  if (!f) throw new Error('卡面不能为空');
  if (!b) throw new Error('卡背不能为空');
  if (f.length > 2000) throw new Error('卡面太长（≤2000 字）');
  if (b.length > 4000) throw new Error('卡背太长（≤4000 字）');
  return {
    id: deckMakeId(f, now),
    front: f,
    back: b,
    tags: (Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/)).map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 8),
    ef: SM2.SM2_START_EF,
    interval: 0,
    repetitions: 0,
    due: now,
    createdAt: now,
    reps: 0,     // 总复习次数
    lapses: 0,   // 总忘记次数
  };
}

/** 追加到卡组（新卡在前）。返回 {deck, added}——重复卡（front+back 全等）不重复加。 */
function deckAdd(deck, card, max = DECK_MAX) {
  const dupe = deck.find((c) => c.front === card.front && c.back === card.back);
  if (dupe) return { deck, added: false, id: dupe.id };
  const next = [card, ...deck].slice(0, max);
  return { deck: next, added: true, id: card.id };
}

function deckRemove(deck, id) {
  return deck.filter((c) => c.id !== id);
}

/** 到期队列：due 升序（最欠的先看），limit 可选。
 *  同 due 的卡按 createdAt 升序（先建的先复习），再按数组序——保证顺序确定。 */
function deckDueCards(deck, now = Date.now(), limit = 0) {
  const due = deck
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => SM2.sm2IsDue(card, now))
    .sort((a, b) => (a.card.due - b.card.due)
      || (a.card.createdAt - b.card.createdAt)
      || (a.index - b.index))
    .map(({ card }) => card);
  return limit > 0 ? due.slice(0, limit) : due;
}

/** 复习统计。 */
function deckStats(deck, now = Date.now()) {
  const due = deck.filter((c) => SM2.sm2IsDue(c, now)).length;
  const learning = deck.filter((c) => c.repetitions > 0 && c.repetitions < 3).length;
  const mature = deck.filter((c) => c.repetitions >= 3 && c.interval >= 21).length;
  return { total: deck.length, due, learning, mature };
}

/** 复习一张卡：SM-2 结算 + 计数。返回新卡（不改原对象）。 */
function deckReview(card, grade, now = Date.now()) {
  const result = SM2.sm2Review(card, grade, now);
  return {
    ...card,
    ...result,
    reps: card.reps + 1,
    lapses: card.lapses + (grade === 'forget' ? 1 : 0),
  };
}

/** 把复习结果写回卡组。 */
function deckApplyReview(deck, id, reviewedCard) {
  return deck.map((c) => (c.id === id ? reviewedCard : c));
}

/**
 * 导入文本：`正面 | 背面` 或制表符分隔，每行一张；`#tag` 开头的行给最近一张卡打标签。
 * 返回 {cards, errors}——坏行进 errors 不中断整批。
 * 同一批里每张卡的 createdAt 依次 +1 微秒级偏移（保持"先建的先复习"的稳定次序）。
 */
function deckImportText(text, now = Date.now()) {
  const cards = [];
  const errors = [];
  let pendingTags = [];
  let seq = 0;
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      pendingTags = line.slice(1).split(/[\s,，]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
      continue;
    }
    const sep = line.includes('\t') ? '\t' : (line.includes(' | ') ? ' | ' : (line.includes('|') ? '|' : null));
    if (!sep) {
      errors.push({ line: i + 1, text: line.slice(0, 40), reason: '没有分隔符（用 | 或 Tab 分隔正反面）' });
      continue;
    }
    const idx = line.indexOf(sep);
    try {
      const card = deckMakeCard({ front: line.slice(0, idx), back: line.slice(idx + sep.length), tags: pendingTags }, now + seq);
      cards.push(card);
      seq += 1;
      pendingTags = [];
    } catch (err) {
      errors.push({ line: i + 1, text: line.slice(0, 40), reason: String(err.message || err) });
    }
  }
  return { cards, errors };
}

/** 导出文本（回来一行一张）。 */
function deckExportText(deck) {
  return deck.map((c) => `${c.front} | ${c.back}`).join('\n');
}

/** 极简 Markdown 渲染（安全：先转义 HTML，再接受 **粗体** *斜体* `代码` 与换行）。 */
function deckRenderMarkdown(text) {
  const esc = String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br />');
}

const FlashDeck = {
  DECK_KEY, SESSION_KEY, DECK_MAX,
  deckMakeId, deckMakeCard, deckAdd, deckRemove, deckDueCards, deckStats,
  deckReview, deckApplyReview, deckImportText, deckExportText, deckRenderMarkdown,
};
