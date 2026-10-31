// lib/workshop.js —— 工坊页：时间线 + 保存/回滚/删除/改名
//
// 一个文档两副面孔：常驻帧只有业务函数（时间线渲染它根本不做）；工坊页每 5 秒
// 刷一次清单。回滚带两道确认：confirmRollback 开关 + 二次点击（第一次点变成
// 「再点一次确认回滚」）。

'use strict';

/** 二次确认的记忆：id → 上次点击时间。3 秒内点第二次才算数。 */
let confirmId = '';
let confirmAt = 0;
const CONFIRM_WINDOW_MS = 3000;

async function renderWorkshop() {
  await refreshCfg();
  renderTimeline();
  renderLog();
  renderStatus();
}

function renderStatus() {
  if (!els.chipState) return;
  els.chipState.textContent = '状态时光机';
  if (els.statusError) els.statusError.textContent = snapshotState.lastError || '';
  if (els.snapCreate) {
    els.snapCreate.disabled = snapshotState.busy;
    els.snapCreate.textContent = snapshotState.busy ? '正在打包…' : '保存当前状态';
  }
}

/** 时间线：每份快照一行（时间、名字、统计、恢复/删除按钮）。 */
async function renderTimeline() {
  if (!els.timeline) return;
  const list = await SnapStore.list();
  els.timeline.replaceChildren();
  if (!list.length) {
    if (els.timelineEmpty) els.timelineEmpty.hidden = false;
    renderStatus();
    return;
  }
  if (els.timelineEmpty) els.timelineEmpty.hidden = true;
  // 时间线从新到旧。
  for (const entry of [...list].reverse()) {
    const row = document.createElement('li');
    row.className = 'snap-row';

    const dot = document.createElement('span');
    dot.className = 'snap-dot';

    const main = document.createElement('div');
    main.className = 'snap-main';

    const title = document.createElement('p');
    title.className = 'snap-name';
    title.textContent = entry.name;

    const meta = document.createElement('p');
    meta.className = 'snap-meta muted';
    const counts = entry.counts || {};
    meta.textContent = [
      new Date(entry.at).toLocaleString(),
      counts.roleSessions !== undefined ? `${counts.roleSessions} 会话` : '',
      counts.roles ? `${counts.roles} 条长期记忆` : '',
      `${Math.max(1, Math.round(entry.bytes / 1024))} KB`,
    ].filter(Boolean).join(' · ');

    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'snap-actions';

    const rollbackBtn = document.createElement('button');
    rollbackBtn.className = 'btn tiny primary';
    rollbackBtn.type = 'button';
    rollbackBtn.textContent = flag('confirmRollback', true) && confirmId === entry.id && now() - confirmAt < CONFIRM_WINDOW_MS
      ? '再点一次确认回滚'
      : '恢复到此刻';
    rollbackBtn.addEventListener('click', () => void rollbackButton(entry, rollbackBtn));

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn tiny';
    renameBtn.type = 'button';
    renameBtn.textContent = '改名';
    renameBtn.addEventListener('click', () => void renameButton(entry));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn tiny danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => void deleteButton(entry));

    actions.append(rollbackBtn, renameBtn, deleteBtn);
    row.append(dot, main, actions);
    els.timeline.appendChild(row);
  }
  renderStatus();
}

async function createButton() {
  if (els.snapCreate) els.snapCreate.disabled = true;
  try {
    const entry = await handleCreateSnapshot({ name: els.snapName ? els.snapName.value : '' });
    if (els.snapName) els.snapName.value = '';
    say(`已保存「${entry.name}」`);
  } catch {
    // lastError 已记录；时间线照旧。
  }
  await renderTimeline();
}

async function rollbackButton(entry, button) {
  if (flag('confirmRollback', true) && !(confirmId === entry.id && now() - confirmAt < CONFIRM_WINDOW_MS)) {
    confirmId = entry.id;
    confirmAt = now();
    button.textContent = '再点一次确认回滚';
    return;
  }
  confirmId = '';
  button.disabled = true;
  try {
    const record = await handleRollback({ id: entry.id });
    if (flag('bubbleOnRollback', true) && granted.has('pet.bubble')) {
      await request('bubble.say', { text: `记忆已回到「${record.name}」那一刻。` }).catch(() => {});
    }
    say(`已回滚到「${record.name}」：恢复 ${record.restored} 项，清除 ${record.removed} 项`);
  } catch {
    // lastError 已记录。
  }
  await renderTimeline();
  await renderLog();
}

async function deleteButton(entry) {
  await SnapStore.remove(entry.id);
  if (confirmId === entry.id) confirmId = '';
  await renderTimeline();
}

async function renameButton(entry) {
  const name = window.prompt ? window.prompt('新的快照名字：', entry.name) : '';
  if (name === null || name === undefined) return;
  await SnapStore.rename(entry.id, name);
  await renderTimeline();
}

async function renderLog() {
  if (!els.rollbackLog) return;
  const log = await loadRollbackLog();
  els.rollbackLog.replaceChildren();
  if (!log.length) {
    if (els.rollbackLogEmpty) els.rollbackLogEmpty.hidden = false;
    return;
  }
  if (els.rollbackLogEmpty) els.rollbackLogEmpty.hidden = true;
  for (const record of log) {
    const item = document.createElement('li');
    item.textContent = `${new Date(record.at).toLocaleString()} 回到「${record.name}」（恢复 ${record.restored} 项）`;
    els.rollbackLog.appendChild(item);
  }
}

/** 读一遍设置。配置权限未授予时**不发请求**（与另外两个新插件同一纪律）。 */
function refreshCfg() {
  if (!granted.has('plugin.config')) return Promise.resolve();
  return request('config.get', {})
    .then((out) => {
      cfg = Object.assign({}, cfg, (out && out.values) || {});
    })
    .catch(() => {});
}
