'use strict';

// 两副面孔的渲染。
//
//   工坊页（#workshop）  控制中心的插件页：拖入区、类型表、分组统计、SVG 条形图。
//   卡片（#card）        桌宠旁边那 300×150 的一格：行列数、一行分组结论、一个模型按钮。
//
// 两边是同一个文档、同一份脚本，靠 init.surface.slot 决定画哪一副（手册 §5.2 / §9）：
// slot==='workshop' 是控制中心，其余都是桌宠。**别用 kind 判断**——常驻帧的 kind 也是 panel。
//
// 渲染函数只碰 DOM，不做请求：请求全部在 app.js 里，因为这一层没有权限信息，也不该有。

function el(id) {
  return document.getElementById(id);
}

function show(node, on) {
  if (node) node.hidden = !on;
}

function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setStatus(text) {
  const node = el('status');
  if (node) node.textContent = String(text == null ? '' : text);
}

/** 空状态：工坊页整块换成一句话，结果区收起来（否则一片空表格比"没有表"更让人困惑）。 */
function showWorkshopEmpty(text) {
  show(el('result'), false);
  const empty = el('empty');
  if (empty) {
    empty.textContent = String(text == null ? '' : text);
    empty.hidden = false;
  }
}

function metaLine(fileName, table) {
  const bits = [(fileName || '未命名文件') + ' · ' + table.rows.length + ' 行 × ' + table.header.length + ' 列'];
  // "只统计了前 N 行"必须写在界面上：截断了却不说的表，读者会当成全量。
  if (table.truncated) bits.push('只统计了前 ' + table.rows.length + ' 行（文件里共 ' + table.totalRows + ' 行）');
  if (!table.rows.length) bits.push('只有表头，没有数据行');
  return bits.join(' · ');
}

function renderTypes(table) {
  const list = el('types');
  clear(list);
  for (const column of table.columns) {
    const row = document.createElement('li');
    row.className = 'type-row';
    const name = document.createElement('span');
    name.className = 'type-name';
    name.textContent = column.name;
    const tag = document.createElement('span');
    tag.className = 'type-tag type-' + column.type;
    tag.textContent = TYPE_LABELS[column.type] || column.type;
    const meta = document.createElement('span');
    meta.className = 'type-meta';
    meta.textContent = column.filled + ' 个值 / ' + column.empty + ' 个空';
    row.append(name, tag, meta);
    list.appendChild(row);
  }
}

/** 分组列的选择用一排按钮，而不是 <select>：原生下拉的弹层是系统画的，跟这页对不上（手册 §8.6）。 */
function renderGroupTabs(table, groupIndex) {
  const box = el('group-tabs');
  clear(box);
  for (const column of table.columns) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.index = String(column.index);
    button.setAttribute('aria-pressed', column.index === groupIndex ? 'true' : 'false');
    button.textContent = '按 ' + column.name;
    button.addEventListener('click', () => onGroupPick(column.index));
    box.appendChild(button);
  }
}

/**
 * 分组统计的正文 + 图。
 *
 * pairs 由调用方传进来（app.js 已经算过一次）：一面要写进摘要、一面要画，算两次只会让
 * "界面上的数字"和"卡片/模型看到的数字"有机会不一致。
 */
function renderGroups(column, pairs) {
  const line = el('group-line');
  const list = el('group-list');
  clear(list);
  if (!column || !pairs.length) {
    if (line) line.textContent = '这一列没有可以分组的值。';
  } else {
    if (line) line.textContent = '「' + column.name + '」共 ' + pairs.length + ' 组，按行数降序：' + summaryLine(pairs, 4);
    for (const pair of pairs.slice(0, 50)) {
      const row = document.createElement('li');
      row.className = 'group-row';
      const value = document.createElement('span');
      value.className = 'group-value';
      // 空单元格那一组的名字是"（空）"，界面上要看得出来它是空的而不是一个字面量。
      value.textContent = pair.value;
      if (pair.value === BLANK_GROUP) value.classList.add('is-blank');
      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = pair.count + ' 行';
      row.append(value, count);
      list.appendChild(row);
    }
  }

  const box = el('chart');
  clear(box);
  if (pairs.length) box.appendChild(buildBarChart(pairs));
  else if (box) box.textContent = '没有可画的分组。';
}

function renderWorkshopTable(data) {
  show(el('empty'), false);
  show(el('result'), true);
  const meta = el('meta');
  if (meta) meta.textContent = metaLine(data.fileName, data.table);
  renderTypes(data.table);
  renderGroupTabs(data.table, data.groupIndex);
  renderGroups(data.column, data.pairs);
}

// --- 卡片 -------------------------------------------------------------------

function cardMetaLine(summary) {
  const bits = ['当前表格 · ' + summary.rows + ' 行 × ' + summary.cols + ' 列'];
  if (summary.truncated) bits.push('只统计前 ' + summary.rows + ' 行（共 ' + summary.totalRows + ' 行）');
  return bits.join(' · ');
}

/**
 * 卡片三行固定的那一屏。
 *
 * 卡片的高度是 manifest 声明的（150px），内容长了不会"报错"，只会被原生区域裁掉——所以
 * 这里只放三行短文本 + 一块能自己滚动的回复区，绝不往上堆。
 */
function renderCard(state) {
  const summary = state.summary;
  const meta = el('card-meta');
  const group = el('card-group');
  const ask = el('card-ask');
  if (meta) meta.textContent = summary ? cardMetaLine(summary) : '当前表格 · 还没有';
  if (group) {
    if (summary && summary.group && summary.group.pairs.length) {
      group.textContent = '按「' + summary.group.column + '」：' + summaryLine(summary.group.pairs, 3);
    } else if (summary) {
      group.textContent = '这份表没有可用的分组列';
    } else {
      group.textContent = state.message || '把一份 CSV 拖进插件页';
    }
  }
  if (ask) {
    ask.disabled = !(state.canAsk && summary);
    ask.textContent = '让模型解读';
  }
}

function renderCardReply(text, options) {
  const node = el('card-reply');
  if (!node) return;
  node.textContent = String(text == null ? '' : text);
  node.classList.toggle('is-error', !!(options && options.error));
}
