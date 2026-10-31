// lib/workshop.js —— 复习会话渲染（翻转卡、评分按钮、进度、卡组列表）
'use strict';

const FWS = { els: null };

function fwsCollectEls() {
  FWS.els = {};
  for (const id of [
    'chip-due', 'review-progress', 'review-area', 'card-flip', 'face-front',
    'face-back', 'grades', 'next-interval', 'review-empty', 'review-start',
    'import-text', 'import-run', 'export-run', 'import-report',
    'deck-list', 'deck-count', 'deck-empty', 'status', 'fatal',
  ]) {
    FWS.els[id] = document.getElementById(id);
  }
  return FWS.els;
}

function fwsSetStatus(text, kind) {
  const el = FWS.els && FWS.els.status;
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.toggle('danger', kind === 'danger');
}

/** 复习区可见性：session 进行中显示卡面，否则显示空态。 */
function fwsRenderReviewVisibility(active) {
  const area = FWS.els && FWS.els['review-area'];
  const empty = FWS.els && FWS.els['review-empty'];
  const start = FWS.els && FWS.els['review-start'];
  if (area) area.classList.toggle('hidden', !active);
  if (empty) empty.classList.toggle('hidden', active);
  if (start) start.classList.toggle('hidden', active);
}

/** 当前卡片：正面 / 翻转后背面 + 评分按钮组。 */
function fwsRenderCurrentCard(card, revealed, index, total) {
  const els = FWS.els;
  if (!els || !card) return;
  els['review-progress'].textContent = `${index + 1} / ${total}`;
  els['face-front'].innerHTML = FlashDeck.deckRenderMarkdown(card.front);
  els['face-back'].innerHTML = FlashDeck.deckRenderMarkdown(card.back);
  els['card-flip'].classList.toggle('flipped', Boolean(revealed));
  els.grades.classList.toggle('hidden', !revealed);
  // 下一间隔预告（帮助用户选键）：按四键各算一次的间隔。
  if (revealed) {
    const preview = ['forget', 'hard', 'good', 'easy'].map((g) => {
      const r = SM2.sm2Review(card, g, Date.now());
      return `${SM2.GRADES[g].label}→${FlashcardFormat.interval(r.interval)}`;
    });
    els['next-interval'].textContent = preview.join(' · ');
  } else {
    els['next-interval'].textContent = '';
  }
}

function fwsRenderSessionDone(doneCount, total) {
  const els = FWS.els;
  if (!els) return;
  els['review-progress'].textContent = `${doneCount} / ${total}`;
  els['face-front'].innerHTML = '这轮复习完成 🎉';
  els['face-back'].innerHTML = '卡片已按 SM-2 重新排期。下次到期待桌宠叫你。';
  els['card-flip'].classList.add('flipped');
  els.grades.classList.add('hidden');
  els['next-interval'].textContent = '';
}

function fwsSetBusy(busy) {
  const btn = FWS.els && FWS.els['review-start'];
  if (btn) btn.disabled = Boolean(busy);
}

/** 人类可读的间隔。 */
const FlashcardFormat = {
  interval(days) {
    if (days >= 365) return `${(days / 365).toFixed(1)} 年`;
    if (days >= 31) return `${(days / 30).toFixed(1)} 月`;
    if (days >= 1) return `${days} 天`;
    return '1 天内';
  },
};

/** 卡组列表。onDelete(id) 由 app.js 注入。 */
function fwsRenderDeck(deck, now, onDelete) {
  const list = FWS.els && FWS.els['deck-list'];
  const empty = FWS.els && FWS.els['deck-empty'];
  const count = FWS.els && FWS.els['deck-count'];
  const chip = FWS.els && FWS.els['chip-due'];
  if (!list || !empty) return;
  list.textContent = '';
  const stats = FlashDeck.deckStats(deck, now);
  if (count) count.textContent = `${stats.total} 张 · 到期 ${stats.due}`;
  if (chip) chip.textContent = `到期 ${stats.due}`;
  empty.classList.toggle('hidden', deck.length > 0);
  const sorted = [...deck].sort((a, b) => a.due - b.due);
  for (const card of sorted) {
    const li = document.createElement('li');
    li.className = 'deck-item';
    const main = document.createElement('div');
    main.className = 'deck-main';
    const front = document.createElement('span');
    front.className = 'deck-front';
    front.textContent = card.front;
    const meta = document.createElement('span');
    meta.className = 'deck-meta';
    const dueIn = card.due - now;
    const dueText = dueIn <= 0 ? '现在该复习' : `还有 ${FlashcardFormat.interval(Math.ceil(dueIn / SM2.DAY_MS))}`;
    meta.innerHTML = `间隔 ${FlashcardFormat.interval(card.interval)} · EF ${card.ef.toFixed(2)} · 复习 ${card.reps} 次·忘 ${card.lapses} 次 · <span class="${dueIn <= 0 ? 'due-now' : ''}">${dueText}</span>`;
    main.appendChild(front);
    main.appendChild(meta);
    const del = document.createElement('button');
    del.className = 'btn tiny';
    del.type = 'button';
    del.textContent = '删除';
    del.addEventListener('click', () => { if (typeof onDelete === 'function') onDelete(card.id); });
    li.appendChild(main);
    li.appendChild(del);
    list.appendChild(li);
  }
}

function fwsRenderImportReport({ added, errors, total }) {
  const el = FWS.els && FWS.els['import-report'];
  if (!el) return;
  if (!errors.length) {
    el.textContent = `导入完成：${added} 张新卡${total ? `（读入 ${total} 行）` : ''}`;
    el.classList.remove('danger');
    return;
  }
  el.textContent = `导入 ${added} 张；${errors.length} 行没认出来：${errors.slice(0, 3).map((e) => `第 ${e.line} 行（${e.reason}）`).join('、')}${errors.length > 3 ? ' 等' : ''}`;
  el.classList.add('danger');
}

const FlashcardsWorkshop = {
  FWS, FlashcardFormat,
  fwsCollectEls, fwsSetStatus, fwsRenderReviewVisibility, fwsRenderCurrentCard,
  fwsRenderSessionDone, fwsSetBusy, fwsRenderDeck, fwsRenderImportReport,
};
