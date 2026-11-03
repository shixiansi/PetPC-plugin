// lib/views.js —— 两副面孔的渲染（浮层面卡片 / 控制中心插件页）
//
// 一条纪律：**两处都各自把「缺哪块」说出来**。报告正文里写了不等于用户看到了——卡片是天天看的
// 那一面，插件页是偶尔打开的那一面，它们各自要能独立回答"这份周报全不全"。

'use strict';

function el(tag, className, body) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (body !== undefined) node.textContent = body;
  return node;
}

function show(node) {
  if (node) node.classList.remove('hidden');
}

function hide(node) {
  if (node) node.classList.add('hidden');
}

/** 只显示当前落点那一面。三面共用一个 entry，靠 init.surface 决定演哪一出。 */
function showFace(role) {
  document.body.dataset.view = role;
  show(role === 'workshop' ? els.workshop : role === 'card' ? els.card : null);
  hide(role === 'workshop' ? els.card : role === 'card' ? els.workshop : null);
}

function fmtWhen(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 卡片第一个数：优先完成率（一个数说清"待办怎么样"），没有就退回"已完成/总共"。 */
function todoNumber(numbers) {
  const n = numbers || {};
  if (n.todoRate !== null && n.todoRate !== undefined) return `${n.todoRate}%`;
  if (n.todoDone !== null && n.todoDone !== undefined && n.todoTotal !== null && n.todoTotal !== undefined) {
    return `${n.todoDone}/${n.todoTotal}`;
  }
  return '–';
}

function numberText(value) {
  return value === null || value === undefined ? '–' : `${value}`;
}

/** 浮层面那张 300×140 的卡片。三行、每行单行，绝不靠"内容自己长高"（高度是声明死的）。 */
function renderCard(record) {
  if (!els.card) return;
  const range = weekRangeOf(now());
  if (els.cardWeek) {
    els.cardWeek.textContent = record && record.week ? `周报 · ${record.week}` : `周报 · ${weekLabel(range)}`;
  }
  const numbers = (record && record.numbers) || {};
  if (els.numTodo) els.numTodo.textContent = todoNumber(numbers);
  if (els.numFocus) els.numFocus.textContent = numberText(numbers.focusMinutes);
  if (els.numDiary) els.numDiary.textContent = numberText(numbers.diaryCount);

  const missing = record && Array.isArray(record.missing) ? record.missing : [];
  if (els.cardMissing) {
    if (missing.length) {
      // 只点名"缺哪块"：原因放在插件页与正文里，140px 高放不下，硬塞会把下一行顶出矩形。
      els.cardMissing.textContent = `缺：${missing.map((miss) => miss.label).join('、')}`;
      show(els.cardMissing);
    } else {
      els.cardMissing.textContent = '';
      hide(els.cardMissing);
    }
  }
  if (els.cardLine) {
    if (record && record.summary) els.cardLine.textContent = record.summary;
    else if (record && record.text) els.cardLine.textContent = clip(record.text, 40);
    else els.cardLine.textContent = '还没有周报，点「生成」。';
  }
}

/** 三个来源各自有没有答上来（插件页里那三行）。缺的那一行写的是同一句缺块话。 */
function renderSources(record) {
  if (!els.sources) return;
  els.sources.textContent = '';
  const missing = record && Array.isArray(record.missing) ? record.missing : [];
  const n = (record && record.numbers) || {};
  const has = (v) => v !== null && v !== undefined;
  const detail = {
    todo: has(n.todoTotal) ? `共 ${n.todoTotal} 件、完成 ${n.todoDone} 件、还挂着 ${n.todoOpen} 件` : '',
    focus: has(n.focusMinutes) ? `今天 ${n.focusMinutes} 分钟、${n.focusSessions} 段番茄钟` : '',
    diary: has(n.diaryCount)
      ? `这周 ${n.diaryCount} 篇（${record.diaryIncluded ? '片段已写进报告' : '只取了篇数，正文没进报告'}）`
      : '',
  };
  for (const source of SOURCES) {
    const row = el('li');
    row.append(el('b', '', source.label));
    const gone = missing.find((miss) => miss.key === source.key);
    if (gone) row.append(el('span', 'gone', gone.line));
    else if (!record) row.append(el('span', '', '还没有生成过任何一份。'));
    else if (detail[source.key]) row.append(el('span', 'ok', detail[source.key]));
    else row.append(el('span', '', '这个来源没有数据。'));
    els.sources.append(row);
  }
}

/** 控制中心插件页：完整的一份 + 来源清单。这一面**只读**（这里不服务 plugin.call）。 */
function renderWorkshop(record) {
  if (!els.latestTitle) return;
  if (!record || !record.text) {
    els.latestTitle.textContent = '还没有周报';
    if (els.latestMeta) els.latestMeta.textContent = '';
    if (els.latestText) els.latestText.textContent = '在桌宠那边点「生成」之后，这一篇会出现在这里。';
  } else {
    els.latestTitle.textContent = record.title || `周报 · ${record.week || ''}`;
    if (els.latestMeta) {
      const source = record.source === 'model' ? '模型润色' : '模板';
      els.latestMeta.textContent = `${fmtWhen(record.at)} · ${source} · ${record.text.length} 字`;
    }
    if (els.latestText) els.latestText.textContent = record.text;
  }
  if (els.latestMissing) {
    const missing = record && Array.isArray(record.missing) ? record.missing : [];
    if (missing.length) {
      els.latestMissing.textContent = missing.map((miss) => miss.line).join('；');
      show(els.latestMissing);
    } else {
      els.latestMissing.textContent = '';
      hide(els.latestMissing);
    }
  }
  renderSources(record);
}
