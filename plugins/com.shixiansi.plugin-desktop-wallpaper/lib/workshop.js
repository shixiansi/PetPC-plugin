// lib/workshop.js —— 工坊页渲染（只管画）
'use strict';

const WWS = { els: null };

function wwsCollectEls() {
  WWS.els = {};
  for (const id of [
    'chip-mood', 'ambient-swatch', 'ambient-title', 'ambient-meta', 'palette',
    'fetch-bing', 'republish', 'status', 'blur-box', 'blur-img', 'blur-empty',
    'history', 'history-empty', 'fatal',
  ]) {
    WWS.els[id] = document.getElementById(id);
  }
  return WWS.els;
}

function wwsSetStatus(text, kind) {
  const el = WWS.els && WWS.els.status;
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.toggle('danger', kind === 'danger');
}

/** 画环境快照：主色块（渐变背景）、标题、meta、色板、mood 徽标。 */
function wwsRenderAmbient(ambient) {
  const swatch = WWS.els && WWS.els['ambient-swatch'];
  const title = WWS.els && WWS.els['ambient-title'];
  const meta = WWS.els && WWS.els['ambient-meta'];
  const chip = WWS.els && WWS.els['chip-mood'];
  if (!swatch || !title || !meta) return;
  if (!ambient || !ambient.primaryHex) {
    swatch.style.background = '';
    title.textContent = '还没有同步过壁纸。';
    meta.textContent = '';
    return;
  }
  swatch.style.background = ambient.gradient || ambient.primaryHex;
  title.textContent = ambient.title || '(无标题)';
  const when = ambient.at ? new Date(ambient.at).toLocaleString() : '';
  meta.textContent = `${ambient.source === 'bing' ? 'Bing 每日壁纸' : '本机壁纸'} · 主色 ${ambient.primaryHex} · 情绪 ${ambient.mood || '—'} · ${when}`;
  if (chip) chip.textContent = `环境：${ambient.mood || '—'}（${ambient.primaryHex}）`;
  const palette = WWS.els && WWS.els.palette;
  if (palette) {
    palette.textContent = '';
    for (const c of ambient.palette || []) {
      const sw = document.createElement('span');
      sw.className = 'palette-swatch';
      sw.style.background = c.hex;
      sw.title = `${c.hex}（占比 ${Math.round(c.share * 100)}%）`;
      const share = document.createElement('span');
      share.className = 'share';
      share.textContent = `${Math.round(c.share * 100)}%`;
      sw.appendChild(share);
      palette.appendChild(sw);
    }
  }
}

function wwsRenderBlur(dataUrl) {
  const box = WWS.els && WWS.els['blur-box'];
  const img = WWS.els && WWS.els['blur-img'];
  const empty = WWS.els && WWS.els['blur-empty'];
  if (!box || !img || !empty) return;
  if (!dataUrl) {
    box.classList.add('hidden');
    img.src = '';
    empty.classList.remove('hidden');
    return;
  }
  img.src = dataUrl;
  box.classList.remove('hidden');
  empty.classList.add('hidden');
}

function wwsRenderHistory(history) {
  const list = WWS.els && WWS.els.history;
  const empty = WWS.els && WWS.els['history-empty'];
  if (!list || !empty) return;
  list.textContent = '';
  empty.classList.toggle('hidden', (history || []).length > 0);
  for (const h of history || []) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const sw = document.createElement('span');
    sw.className = 'history-swatch';
    sw.style.background = h.gradient || h.primaryHex || '';
    const main = document.createElement('div');
    main.className = 'history-main';
    const t = document.createElement('span');
    t.className = 'history-title';
    t.textContent = h.title || '(无标题)';
    const m = document.createElement('span');
    m.className = 'history-meta';
    m.textContent = `${h.primaryHex} · ${h.mood || '—'} · ${h.at ? new Date(h.at).toLocaleString() : ''}`;
    main.appendChild(t);
    main.appendChild(m);
    li.appendChild(sw);
    li.appendChild(main);
    list.appendChild(li);
  }
}

function wwsSetBusy(busy) {
  const btn = WWS.els && WWS.els['fetch-bing'];
  if (btn) {
    btn.disabled = Boolean(busy);
    btn.textContent = busy ? '抓取中…' : '抓今日 Bing 壁纸';
  }
}

const WallpaperWorkshop = { WWS, wwsCollectEls, wwsSetStatus, wwsRenderAmbient, wwsRenderBlur, wwsRenderHistory, wwsSetBusy };
