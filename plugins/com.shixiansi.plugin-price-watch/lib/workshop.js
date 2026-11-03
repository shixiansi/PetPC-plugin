// lib/workshop.js —— 插件页那一面：只展示与设置
//
// 这一页**不抓取、不弹气泡**，两个理由都是硬的：`bubble.say` 只在桌宠程序里被服务（手册 §9），
// 控制中心没有宠物窗口，所以"变了说一句"必须由桌宠那边的常驻帧做——这里若放一个"现在抓一次"的
// 按钮，抓到的变化只会**静默地**更新基线（用户看不到提醒，还以为插件坏了）；而且抓取与快照的
// 写者只能有一个（手册 §6.3），让它只有常驻帧，规则就永远成立。所以这一页只做：读设置 → 读快照
// → 画出来，并在数据变化时重画。它靠 `storage` 与 `plugin.config`（两个宿主都服务），所以页面上
// 不需要 hide-only 的花招。

'use strict';

let rendering = false;
let rerenderQueued = false;

function el(tag, className, body) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (body !== undefined) node.textContent = body;
  return node;
}

/** 读一遍要显示的东西；读不到的那部分留空，原因交给 status 行说。 */
async function collectView() {
  const view = { cfgOk: true, cfgError: '', rows: [], history: [], canRead: granted.has('storage') };
  try {
    await refreshConfig();
  } catch (err) {
    view.cfgOk = false;
    view.cfgError = errorText(err);
  }
  for (const entry of parseEntries(cfg.entries)) {
    let snap = null;
    if (entry.id && view.canRead) {
      try {
        snap = await loadSnapshot(entry.id);
      } catch {
        snap = null; // 读不到就当"还没抓过"：页面绝不因为一次读失败而崩。
      }
    }
    view.rows.push({ entry, snap });
  }
  if (view.canRead) {
    try {
      view.history = await loadHistory();
    } catch {
      view.history = [];
    }
  }
  return view;
}

/** 顶部三枚 chip：几条、多久抓一次、免打扰是哪一段。 */
function paintChips(view) {
  if (els.chipCount) els.chipCount.textContent = `监控 ${view.rows.filter((row) => !row.entry.problem).length} 条`;
  if (els.chipInterval) els.chipInterval.textContent = `每 ${Math.round(intervalMs() / 60000)} 分钟抓一次`;
  if (els.chipQuiet) {
    const from = String(cfg.quietFrom || '').trim();
    const to = String(cfg.quietTo || '').trim();
    els.chipQuiet.textContent = from && to ? `免打扰 ${from}–${to}` : '没有免打扰';
  }
}

/** 一条监控：名字、状态、上次抓取时间、失败时的"上次成功是多久前"。 */
function renderEntry(row) {
  const { entry, snap } = row;
  const status = statusOf(entry, snap);
  const box = el('div', 'entry');

  const head = el('div', 'entry-head');
  head.append(el('span', 'entry-name', entry.name || entry.url || '(没有名字)'));
  head.append(el('span', `tag ${status.kind}`, status.label));
  box.append(head);

  const meta = [];
  if (entry.url) meta.push(entry.url);
  if (entry.selector) meta.push(`只看 ${entry.selector}`);
  if (snap && snap.at) meta.push(`上次抓取 ${fmtTime(snap.at)}`);
  box.append(el('p', 'entry-meta', meta.join(' · ')));

  if (status.label === '失败') {
    // 失败时最要紧的一句：快照还在，但它是**多久以前的**。
    const lost = snap && snap.lastOkAt ? `上次成功是 ${fmtAgo(snap.lastOkAt)}` : '还没有成功过';
    box.append(el('p', 'entry-alert', `${status.detail}（快照保留着；${lost}）`));
  } else if (status.label === '未配置') {
    box.append(el('p', 'entry-alert', status.detail || '这一行读不出要监控的东西'));
  } else if (snap && snap.excerpt) {
    box.append(el('p', 'entry-excerpt', `上次抓到：${excerpt(snap.excerpt, 100)}`));
  }
  return box;
}

/** 一条变化：谁、什么时候、变的那一小段。 */
function renderChange(change) {
  const row = el('div', 'change');
  const head = el('div', 'change-head');
  head.append(el('span', 'change-name', change.name || change.url || '(没有名字)'));
  head.append(el('span', 'change-time', `${fmtTime(change.at)}${change.quiet ? ' · 免打扰时段' : ''}`));
  row.append(head);
  const body = change.snippet || change.after || '';
  row.append(el('p', 'change-text', body ? `变了的一段：${body}` : '内容变了（看不出具体是哪一段）'));
  return row;
}

async function renderWorkshop() {
  if (!els.workshop) return;
  if (rendering) {
    rerenderQueued = true;
    return;
  }
  rendering = true;
  try {
    const view = await collectView();
    paintChips(view);

    els.entries.textContent = '';
    for (const row of view.rows) els.entries.append(renderEntry(row));
    if (els.entriesEmpty) els.entriesEmpty.classList.toggle('hidden', view.rows.length > 0);

    els.changes.textContent = '';
    for (const change of view.history.slice(0, 6)) els.changes.append(renderChange(change));
    if (els.changesEmpty) els.changesEmpty.classList.toggle('hidden', view.history.length > 0);

    if (!view.cfgOk) say(`读不到设置：${text(view.cfgError, 160)}`);
    else if (!view.canRead) say('未获授权：storage（读不到快照与历史）');
    else if (!view.rows.length) say('');
  } finally {
    rendering = false;
    if (rerenderQueued) {
      rerenderQueued = false;
      void renderWorkshop().catch(() => {});
    }
  }
}
