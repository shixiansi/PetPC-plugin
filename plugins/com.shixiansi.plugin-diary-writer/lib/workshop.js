// lib/workshop.js —— 插件页那一面：立刻写一篇 + 日记列表
//
// 与 websearch / rss-reader 的 workshop 同一条纪律：控制中心不服务 plugin.call /
// bubble（手册 §9），「立刻写一篇」按钮在这一页禁用；日记列表（storage 只读）照常显示。

'use strict';

let writing = false;

function el(tag, className, body) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (body !== undefined) node.textContent = body;
  return node;
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const pad = (x) => `${x}`.padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setWriting(on) {
  writing = on;
  if (els.writeNow) {
    els.writeNow.disabled = on || !granted.has('plugin.call');
    els.writeNow.textContent = on ? '写着…' : '立刻写一篇';
  }
}

/** 「立刻写一篇」（面板按钮与 write_now 走同一条 writeDiary）。 */
async function runWriteNow() {
  if (writing) return;
  setWriting(true);
  say('正在汇总今天…');
  try {
    const entry = await writeDiary();
    say(`写好了（${moodLabel(entry.mood)}）`);
    void renderDiaries();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 200));
  } finally {
    setWriting(false);
  }
}

/** 最近日记列表（最新在最上）。 */
async function renderDiaries() {
  if (!els.list) return;
  const entries = await loadRecentDiaries(7);
  els.list.textContent = '';
  if (!entries.length) {
    els.list.append(el('p', 'muted', '还没有日记。'));
    return;
  }
  if (els.latest) els.latest.textContent = entries[0].text;
  if (els.latestMeta) {
    els.latestMeta.textContent = `${entries[0].day} · ${moodLabel(entries[0].mood)} · ${fmtTime(entries[0].at)}`;
  }
  for (const entry of entries) {
    const row = el('div', 'diary');
    const head = el('div', 'diary-head');
    head.append(el('span', 'diary-day', `${entry.day} · ${moodLabel(entry.mood)}`));
    row.append(head);
    row.append(el('p', 'diary-text', text(entry.text, 300)));
    els.list.append(row);
  }
}
