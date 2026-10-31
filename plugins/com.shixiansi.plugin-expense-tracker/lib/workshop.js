// lib/workshop.js —— 看板渲染（环形图、折线图、流水；只管画）
'use strict';

const XWS = { els: null, month: '' };

function xwsCollectEls() {
  XWS.els = {};
  for (const id of [
    'chip-month', 'month-prev', 'month-next', 'totals', 'donut', 'trend',
    'board-status', 'manual-amount', 'manual-type', 'manual-category',
    'manual-note', 'manual-add', 'ledger-list', 'ledger-count',
    'ledger-empty', 'status', 'fatal',
  ]) {
    XWS.els[id] = document.getElementById(id);
  }
  return XWS.els;
}

function xwsSetStatus(text, kind) {
  const el = XWS.els && XWS.els.status;
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.toggle('danger', kind === 'danger');
}

/** 画看板：合计、环形图、图例、折线图。 */
function xwsRenderBoard(month, agg) {
  const els = XWS.els;
  if (!els || !agg) return;
  XWS.month = month;
  els['chip-month'].textContent = month;
  const fmt = (n) => n.toFixed(2).replace(/\.00$/, '');
  els.totals.innerHTML = [
    `<span class="total-item"><span class="num expense"><span class="yen">¥</span>${fmt(agg.totals.expense)}</span><span class="cap">支出</span></span>`,
    `<span class="total-item"><span class="num income"><span class="yen">¥</span>${fmt(agg.totals.income)}</span><span class="cap">收入</span></span>`,
    `<span class="total-item"><span class="num"><span class="yen">¥</span>${fmt(agg.totals.refund)}</span><span class="cap">退款</span></span>`,
    `<span class="total-item"><span class="num">${agg.totals.count}</span><span class="cap">笔数</span></span>`,
  ].join('');
  els.donut.innerHTML = ExpenseCharts.chartDonut(agg.byCategory, agg.totals.expense);
  // 图例挂在环形图旁边（donut 的父级 .charts 里插一个容器，每次重建）。
  let legend = document.getElementById('donut-legend');
  if (!legend) {
    legend = document.createElement('div');
    legend.id = 'donut-legend';
    legend.className = 'legend';
    els.donut.parentNode.insertBefore(legend, els.donut.nextSibling);
  }
  legend.innerHTML = ExpenseCharts.chartLegend(agg.byCategory);
  els.trend.innerHTML = ExpenseCharts.chartTrend(agg.byDay);
}

const CATEGORY_ICONS = { 餐饮: '食', 交通: '行', 购物: '购', 娱乐: '娱', 居住: '住', 医疗: '医', 教育: '学', 通讯: '话', 旅行: '游', 工资: '薪', 报销: '报', 红包: '红', 其他: '杂' };

/** 流水列表。onDelete(id) 由 app.js 注入。 */
function xwsRenderLedger(entries, onDelete) {
  const els = XWS.els;
  if (!els) return;
  const list = els['ledger-list'];
  const empty = els['ledger-empty'];
  list.textContent = '';
  els['ledger-count'].textContent = `${entries.length} 笔`;
  empty.classList.toggle('hidden', entries.length > 0);
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'ledger-item';
    const cat = document.createElement('span');
    cat.className = 'ledger-cat';
    cat.textContent = CATEGORY_ICONS[e.category] || '杂';
    cat.title = e.category;
    const main = document.createElement('div');
    main.className = 'ledger-main';
    const note = document.createElement('span');
    note.className = 'ledger-note';
    note.textContent = e.note || e.raw || e.category;
    const meta = document.createElement('span');
    meta.className = 'ledger-meta';
    meta.textContent = `${e.day} · ${e.category}${e.raw ? ` · 「${e.raw}」` : ''}`;
    main.appendChild(note);
    main.appendChild(meta);
    const amount = document.createElement('span');
    amount.className = `ledger-amount ${e.type}`;
    const sign = e.type === 'income' ? '+' : (e.type === 'refund' ? '±' : '−');
    amount.textContent = `${sign}${e.amount.toFixed(2)}`;
    const del = document.createElement('button');
    del.className = 'btn tiny';
    del.type = 'button';
    del.textContent = '删';
    del.addEventListener('click', () => { if (typeof onDelete === 'function') onDelete(e.id); });
    li.appendChild(cat);
    li.appendChild(main);
    li.appendChild(amount);
    li.appendChild(del);
    list.appendChild(li);
  }
}

function xwsRenderMonthOptions() {
  const sel = XWS.els && XWS.els['manual-category'];
  if (!sel) return;
  sel.textContent = '';
  for (const c of ExpenseParse.EXPENSE_CATEGORIES) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
}

const ExpenseWorkshop = {
  XWS, CATEGORY_ICONS,
  xwsCollectEls, xwsSetStatus, xwsRenderBoard, xwsRenderLedger, xwsRenderMonthOptions,
};
