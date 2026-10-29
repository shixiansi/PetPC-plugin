// lib/workshop.js —— 插件页那一面：连上没有、回答了几个、为什么没答
//
// 这个适配器最需要被看见的不是"它记得什么"（它什么都不记），而是**它连上没有、最近为什么没答**。
// 一个安静的机器人在 QQ 群里和"没装"没有区别，所以这里的每一行都是为了让"没反应"有原因可查。
//
// 它在控制中心里跑（slot: 'workshop'），那里不服务 net.ws——所以这一面的按钮永远不碰连接，
// 只读 state/* 与 config.*，并且明确写出"连接归桌宠的常驻帧管"。

'use strict';

function el(tag, className, body) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (body !== undefined) node.textContent = body;
  return node;
}

function factLine(label, value) {
  const row = el('div', 'fact');
  row.append(el('span', 'fact-label', label), el('span', 'fact-value', value));
  return row;
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const pad = (x) => `${x}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function renderWorkshop() {
  if (!els.workshop) return;
  els.workshop.classList.remove('hidden');
  await refreshConfig();
  renderStatus();

  const status = await readJSON('state/status', {});
  const groups = await readJSON('state/groups', {});
  const stored = await readJSON('state/notes', []);
  if (Array.isArray(stored) && stored.length) {
    notes.length = 0;
    for (const item of stored.slice(-40)) notes.push(item);
  }

  if (els.facts) {
    els.facts.textContent = '';
    els.facts.append(
      factLine('回答', `${Number(status.answered) || 0} 次`),
      factLine('跳过', `${Number(status.skipped) || 0} 次（没 @ 它、没前缀、冷却中）`),
      factLine('失败', `${Number(status.failed) || 0} 次`),
      factLine('把人设与记忆交给', 'com.shixiansi.plugin-memcore 的 chat 方法'),
      factLine('最近一次活动', fmtTime(status.lastAt)),
    );
    if (status.lastError && status.lastError.message) {
      els.facts.append(factLine('最近一次失败', `${fmtTime(status.lastError.at)} · ${status.lastError.message}`));
    }
  }

  if (els.groups) {
    els.groups.textContent = '';
    const keys = Object.keys(groups || {});
    if (els.groupsEmpty) els.groupsEmpty.hidden = keys.length > 0;
    for (const key of keys.sort()) {
      const row = groups[key] || {};
      const tr = el('tr');
      tr.append(
        el('td', 'mono', key),
        el('td', '', `${Number(row.count) || 0}`),
        el('td', '', fmtTime(row.lastAt)),
      );
      els.groups.append(tr);
    }
  }

  renderNotes();
  say(`已刷新 · ${new Date().toLocaleTimeString()}`);
}
