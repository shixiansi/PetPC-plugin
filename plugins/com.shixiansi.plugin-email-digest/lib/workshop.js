// lib/workshop.js —— 工坊页：立即摘要按钮、最近一批邮件的分类列表、历史记录

'use strict';

function renderWorkshop() {
  renderStatus();
}

function renderStatus() {
  if (!els.chipState) return;
  const last = digestState.lastRun;
  els.chipState.textContent = last
    ? `上次摘要 ${new Date(last.at).toLocaleString()}`
    : '邮件摘要';
  if (els.statTotal) els.statTotal.textContent = String(last ? last.total : 0);
  if (els.statUrgent) els.statUrgent.textContent = String(last ? last.urgent : 0);
  if (els.statSpam) els.statSpam.textContent = String(last ? last.spam : 0);
  if (els.statusError) els.statusError.textContent = digestState.lastError || '';
  if (els.statusNote) els.statusNote.textContent = digestState.lastError ? '' : (digestState.busy ? '正在抓取与分类…' : '待命。到点自动推送，或点「立即生成摘要」。');
  if (els.digestNow) {
    els.digestNow.disabled = digestState.busy;
    els.digestNow.textContent = digestState.busy ? '正在生成…' : '立即生成摘要';
  }
  renderMails();
}

/** 最近一批邮件（按分类着色/加标记）。 */
function renderMails() {
  if (!els.mailList) return;
  const last = digestState.lastRun;
  els.mailList.replaceChildren();
  const mails = last && Array.isArray(last.mails) ? last.mails : [];
  if (!mails.length) {
    if (els.mailEmpty) els.mailEmpty.hidden = false;
    return;
  }
  if (els.mailEmpty) els.mailEmpty.hidden = true;
  for (const mail of mails) {
    const row = document.createElement('li');
    row.className = `mail-row mail-${mail.kind}`;

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = mail.kind === 'urgent' ? '紧急' : mail.kind === 'spam' ? '垃圾' : '常规';
    if (mail.kind === 'urgent') tag.classList.add('accent');
    else if (mail.kind === 'spam') tag.classList.add('warn');
    else tag.classList.add('ok');

    const main = document.createElement('div');
    main.className = 'mail-main';
    const subject = document.createElement('p');
    subject.className = 'mail-subject';
    subject.textContent = mail.subject || '(无主题)';
    const meta = document.createElement('p');
    meta.className = 'mail-meta muted';
    meta.textContent = [
      mail.from || '?',
      mail.summary || '',
      mail.reason && !mail.summary ? mail.reason : '',
    ].filter(Boolean).join(' · ');

    main.append(subject, meta);
    row.append(tag, main);
    els.mailList.appendChild(row);
  }
}

async function renderLog() {
  if (!els.logList) return;
  const log = await loadLog();
  els.logList.replaceChildren();
  if (!log.length) {
    if (els.logEmpty) els.logEmpty.hidden = false;
    return;
  }
  if (els.logEmpty) els.logEmpty.hidden = true;
  for (const record of log) {
    const item = document.createElement('li');
    item.textContent = `${new Date(record.at).toLocaleString()} · 共 ${record.total} 封（紧急 ${record.urgent} / 垃圾 ${record.spam}）`;
    els.logList.appendChild(item);
  }
}

async function digestButton() {
  if (els.digestNow) els.digestNow.disabled = true;
  renderStatus();
  try {
    await digestOnce({ push: true });
  } catch {
    // lastError 已记录。
  }
  renderStatus();
  await renderLog();
}

/** 读一遍设置。配置权限未授予时**不发请求**。 */
function refreshCfg() {
  if (!granted.has('plugin.config')) return Promise.resolve();
  return request('config.get', {})
    .then((out) => {
      cfg = Object.assign({}, cfg, (out && out.values) || {});
    })
    .catch(() => {});
}
