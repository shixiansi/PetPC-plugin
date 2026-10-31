// lib/workshop.js —— 工坊页渲染（只管画，不做业务判断）
//
// 业务链路（抓取/入库）都在 lib/scrape.js 与 lib/library.js；这个文件把状态画到 DOM 上，
// 并把按钮事件翻译成对 orchestrate 的调用。测试驱动 renderLibrary / renderProgress /
// renderPreview 时注入一个假的 document 也是可以的——但这里直接用真实 jsdom 更省事。

'use strict';

const WS = {
  els: null,
};

function wsCollectEls() {
  WS.els = {};
  for (const id of [
    'chip-library', 'url', 'go', 'status', 'progress', 'progress-bar', 'picked',
    'preview', 'send-pet', 'lib-list', 'lib-empty', 'lib-count',
    'hosts', 'hosts-save', 'fatal',
  ]) {
    WS.els[id] = document.getElementById(id);
  }
  return WS.els;
}

function wsSetStatus(text, kind) {
  const el = WS.els && WS.els.status;
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.toggle('danger', kind === 'danger');
}

function wsSetProgress(step) {
  const box = WS.els && WS.els.progress;
  const bar = WS.els && WS.els['progress-bar'];
  if (!box || !bar) return;
  if (!step || step.progress === undefined || step.progress === null) {
    box.classList.add('hidden');
    bar.style.width = '0%';
    return;
  }
  box.classList.remove('hidden');
  bar.style.width = `${Math.round(Math.min(1, Math.max(0, Number(step.progress) || 0)) * 100)}%`;
  if (step.note) wsSetStatus(step.note);
}

function wsSetBusy(busy) {
  const go = WS.els && WS.els.go;
  if (go) {
    go.disabled = Boolean(busy);
    go.textContent = busy ? '提取中…' : '提取';
  }
  const send = WS.els && WS.els['send-pet'];
  if (send && busy) send.disabled = true;
}

/** 画"为什么选这个块"：score/标签/类名/段落与链接密度。 */
function wsRenderPicked(picked) {
  const el = WS.els && WS.els.picked;
  if (!el) return;
  if (!picked) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.classList.remove('hidden');
  const bits = [];
  if (picked.tag) bits.push(`标签 <${picked.tag}>`);
  if (picked.cls) bits.push(`class="${picked.cls}"`);
  if (picked.score !== undefined) bits.push(`得分 ${picked.score}`);
  if (picked.paraCount !== undefined) bits.push(`${picked.paraCount} 个段落`);
  if (picked.textLen !== undefined) bits.push(`${picked.textLen} 字`);
  if (picked.linkDensity !== undefined) bits.push(`链接占比 ${Math.round(picked.linkDensity * 100)}%`);
  el.textContent = '选中：';
  const strong = document.createElement('strong');
  strong.textContent = bits.join(' · ');
  el.appendChild(strong);
}

function wsRenderPreview(markdown) {
  const el = WS.els && WS.els.preview;
  if (el) el.textContent = String(markdown || '');
  const send = WS.els && WS.els['send-pet'];
  if (send) send.disabled = !markdown;
}

/**
 * 画文章库列表。`onOpen` 是点击条目时的回调（拿 id）。
 * @param {object[]} index 索引（新→旧）
 */
function wsRenderLibrary(index, onOpen, currentId) {
  const list = WS.els && WS.els['lib-list'];
  if (!list) return;
  list.textContent = '';
  const count = WS.els && WS.els['lib-count'];
  if (count) count.textContent = index.length ? `${index.length} 篇` : '';
  const chip = WS.els && WS.els['chip-library'];
  if (chip) chip.textContent = `文章库 ${index.length} 篇`;
  const empty = WS.els && WS.els['lib-empty'];
  if (empty) empty.classList.toggle('hidden', index.length > 0);
  for (const entry of index) {
    const li = document.createElement('li');
    li.className = 'lib-item';
    if (entry.id === currentId) li.classList.add('active');
    const main = document.createElement('div');
    main.className = 'lib-main';
    const title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = entry.title || '(无标题)';
    const meta = document.createElement('span');
    meta.className = 'lib-meta';
    meta.textContent = `${entry.host || ''} · ${entry.chars || 0} 字 · ${new Date(entry.at || 0).toLocaleString()}`;
    main.appendChild(title);
    main.appendChild(meta);
    const open = document.createElement('button');
    open.className = 'btn tiny';
    open.type = 'button';
    open.textContent = '打开';
    open.addEventListener('click', () => { if (typeof onOpen === 'function') onOpen(entry.id); });
    li.appendChild(main);
    li.appendChild(open);
    list.appendChild(li);
  }
}

const ScraperWorkshop = { WS, wsCollectEls, wsSetStatus, wsSetProgress, wsSetBusy, wsRenderPicked, wsRenderPreview, wsRenderLibrary };
