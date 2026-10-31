// lib/workshop.js —— 插件页那一面：加文档 / 文档列表 / 索引进度 / 提问
//
// 提问与 ask_kb 走同一条 handleAskKb；控制中心不服务 plugin.call / net.fetch
// （手册 §9），「立刻抓远程文档」按钮在这一页禁用，提问也不可用——但文档列表
// （storage 只读）与索引进度照常显示。

'use strict';

let working = false;

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

function setWorking(on, word) {
  working = on;
  if (els.ask) els.ask.disabled = on || !granted.has('plugin.call');
  if (els.docAdd) els.docAdd.disabled = on;
  if (els.fetchNow) els.fetchNow.disabled = on || !granted.has('net.fetch');
  if (on && els.answer) els.answer.textContent = `${word || '检索中'}…`;
}

/** 添加一份粘贴的文档。 */
async function addPastedDocument() {
  if (working || !els.docText) return;
  const content = String(els.docText.value || '');
  const title = String(els.docTitle && els.docTitle.value || '').trim();
  if (!content.trim()) {
    say('先粘贴文档内容（Markdown / TXT）');
    return;
  }
  setWorking(true, '切片与建索引中');
  try {
    const added = await addDocument({ title, content });
    els.docText.value = '';
    if (els.docTitle) els.docTitle.value = '';
    say(`已入库：${added.title}（${added.chunkCount} 个切片）`);
    void renderDocs();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 200));
  } finally {
    setWorking(false);
  }
}

/** 抓配置里的远程文档。 */
async function fetchRemote() {
  if (working) return;
  setWorking(true, '抓取远程文档');
  try {
    const results = await fetchRemoteDocuments();
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    say(`抓到 ${okCount}/${results.length} 份${failed.length ? `；失败：${failed[0].error}` : ''}`);
    void renderDocs();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 200));
  } finally {
    setWorking(false);
  }
}

/** 提问（面板与 ask_kb 同一条 handleAskKb）。 */
async function runAsk() {
  if (working || !els.question) return;
  const question = String(els.question.value || '').trim();
  if (!question) return;
  setWorking(true, '检索文档');
  try {
    const out = await handleAskKb({ question });
    if (els.answer) {
      els.answer.textContent = out.answer;
      els.answer.dataset.state = 'ready';
    }
    if (els.answerMeta) {
      els.answerMeta.textContent = out.usedContext
        ? `依据：${out.hits.map((h) => `${h.docId}#${h.seq}（${h.score}）`).join('、')}`
        : '未使用文档（相关度不足）';
    }
    els.question.value = '';
    say('');
  } catch (err) {
    say(text(err && err.message ? err.message : err, 200));
    if (els.answer) els.answer.textContent = '';
  } finally {
    setWorking(false);
  }
}

/** 删除一份文档。 */
async function removeDoc(docId) {
  try {
    await removeDocument(docId);
    say('已删除');
    void renderDocs();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 160));
  }
}

/** 文档列表 + 索引进度。 */
async function renderDocs() {
  if (!els.docList) return;
  const docs = await listDocuments();
  const { meta } = await loadIndex();
  if (els.indexBar) {
    els.indexBar.textContent = meta && meta.chunkCount
      ? `索引：${meta.docCount} 份文档 · ${meta.chunkCount} 个切片 · ${meta.terms} 个词条 · 建于 ${fmtTime(meta.builtAt)}`
      : '索引：空（还没有文档）';
  }
  els.docList.textContent = '';
  if (!docs.length) {
    if (els.docEmpty) els.docEmpty.classList.remove('hidden');
    return;
  }
  if (els.docEmpty) els.docEmpty.classList.add('hidden');
  for (const doc of docs.slice().reverse()) {
    const row = el('div', 'doc');
    const head = el('div', 'doc-head');
    head.append(el('span', 'doc-title', doc.title));
    const remove = el('button', 'btn soft doc-remove', '删除');
    remove.type = 'button';
    remove.addEventListener('click', () => void removeDoc(doc.docId).catch(() => {}));
    head.append(remove);
    row.append(head);
    row.append(el('p', 'doc-meta', `${doc.chunkCount} 个切片 · 入库 ${fmtTime(doc.addedAt)}`));
    els.docList.append(row);
  }
}
