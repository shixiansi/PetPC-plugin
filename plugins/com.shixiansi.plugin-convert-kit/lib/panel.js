// lib/panel.js —— 插件页（slot === 'workshop'）的全部界面。
//
// 这一页只做三件小事：选分类 → 选两组单位 → 按一下拿到结果。所以它**没有**自己的状态机：
// 事实只有 panelState 那四个字段，其余每一次都由 convert() 现算。
//
// 两个刻意的取舍：
//
//   · **最近换算只留在内存**。换算是"顺手做一下"的动作，为它写盘只会让宿主日志多几行 DEBUG；
//     真正值得跨次留存的是"上次用的那对单位"（写进 storage，见 persistUnits）。
//   · **错误原样显示**（convert 抛出的中文句子），不统一包成"操作失败"：
//     用户要知道的是"我不认识斤"，不是"出错了"。

'use strict';

const panelState = { category: 'length', from: '', to: '', recent: [] }; // recent: {category, from, to, amount, expression}

let fromSelect = null;
let toSelect = null;

const byId = (id) => document.getElementById(id);
const currentDef = () => CATEGORY_LIST.find((def) => def.id === panelState.category) || CATEGORY_LIST[0];

/** 汇率那一栏按设置项 showRates 决定要不要出现；它不是"换算能力"的开关（plugin.call 照常能问）。 */
function visibleCategories() {
  return CATEGORY_LIST.filter((def) => def.id !== 'currency' || cfg.showRates);
}

/** 每个分类默认的一对单位：不是"前两个"，而是最常被换算的那一对。 */
const DEFAULT_PAIRS = {
  length: ['m', 'ft'], weight: ['kg', 'lb'], volume: ['l', 'ml'], temperature: ['c', 'f'],
  speed: ['kmh', 'mps'], timezone: ['UTC+8', 'UTC'], base: ['10', '16'], currency: ['USD', 'CNY'],
};

/** 每一类"它不做什么"。写在这里而不是错误信息里：错的是前提时，用户不会先看到错误。 */
const KIND_HINTS = {
  temperature: '绝对零度以下的输入会被夹在绝对零度，并在一行里说明。',
  timezone: '只做固定偏移的加减，不含夏令时；跨日会在结果后面标「次日 / 前一日」。',
  base: '不要带 0x / 0b / 0o 前缀——进制由「从」那一栏决定。负数写成 -1011。',
  currency: `汇率来自内置静态快照（${RATES_AS_OF}），完全离线、不是实时价。`,
};

function pairFor(def, restore) {
  const wanted = restore && restore.category === def.id && restore.from && restore.to
    ? [restore.from, restore.to]
    : DEFAULT_PAIRS[def.id];
  const known = (id) => def.units.some((unit) => unit.id === id);
  if (wanted && known(wanted[0]) && known(wanted[1])) return [wanted[0], wanted[1]];
  return [def.units[0].id, def.units[1].id];
}

// --- 分类标签 -----------------------------------------------------------------

function buildTabs() {
  const host = byId('tabs');
  host.textContent = '';
  for (const def of visibleCategories()) {
    const tab = el('button', 'tab');
    tab.type = 'button';
    tab.dataset.category = def.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(def.id === panelState.category));
    tab.textContent = def.label;
    tab.addEventListener('click', () => guard(() => selectCategory(def.id, null)));
    host.append(tab);
  }
}

async function selectCategory(id, restore, autoRun) {
  const def = CATEGORY_LIST.find((item) => item.id === id) || CATEGORY_LIST[0];
  panelState.category = def.id;
  const pair = pairFor(def, restore);
  panelState.from = pair[0];
  panelState.to = pair[1];

  for (const tab of byId('tabs').querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.category === def.id));
  }

  const amount = byId('amount');
  amount.value = restore && restore.category === def.id && restore.amount
    ? String(restore.amount)
    : SAMPLE_VALUES[def.id] || '';
  amount.placeholder = PLACEHOLDERS[def.id] || '';
  amount.inputMode = def.kind === 'number-base' || def.kind === 'timezone' ? 'text' : 'decimal';

  rebuildSelects();
  byId('result').hidden = true;
  byId('error').hidden = true;
  const hint = byId('kind-hint');
  hint.textContent = KIND_HINTS[def.id] || '';
  hint.hidden = !hint.textContent;
  await persistUnits();
  if (autoRun) await runConversion();
}

// --- 两个下拉框 ---------------------------------------------------------------

function rebuildSelects() {
  const options = currentDef().units.map((unit) => ({ value: unit.id, label: `${unit.name} · ${unit.symbol}` }));
  byId('from-slot').textContent = '';
  byId('to-slot').textContent = '';
  fromSelect = makeSelect({
    options,
    value: panelState.from,
    ariaLabel: '从哪个单位换算',
    onChange: (next) => { panelState.from = next; guard(persistUnits); },
  });
  toSelect = makeSelect({
    options,
    value: panelState.to,
    ariaLabel: '换算到哪个单位',
    onChange: (next) => { panelState.to = next; guard(persistUnits); },
  });
  byId('from-slot').append(fromSelect.node);
  byId('to-slot').append(toSelect.node);
}

/**
 * 自绘下拉框（ui.css 的 .select 原语）。
 *
 * 为什么不用原生 `<select>`：它的**弹层是系统画的**——方角、灰底高亮、系统字体，CSS 只能改
 * 收起时的外观（手册 §8.6 直接禁了它）。键盘照 listbox 惯例：Enter/Space/↓ 打开、↑↓ 移动、
 * Home/End 到首尾、Enter 选中、Esc 关闭、Tab 走人；焦点留在触发按钮上。
 */
function makeSelect({ options, value, ariaLabel, onChange }) {
  const wrap = el('div', 'select');
  const trigger = el('button', 'select-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);
  const label = el('span', 'select-value');
  const chev = el('span', 'chev');
  chev.setAttribute('aria-hidden', 'true');
  trigger.append(label, chev);

  const list = el('ul', 'select-list');
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  let current = value;
  let active = -1;

  const items = options.map((option, index) => {
    const item = el('li', 'select-option');
    item.setAttribute('role', 'option');
    item.dataset.value = option.value;
    item.append(el('span', '', option.label), el('span', 'tick', '✓'));
    item.addEventListener('click', () => choose(index));
    item.addEventListener('mousemove', () => setActive(index));
    return item;
  });
  list.append(...items);

  function paint() {
    const found = options.find((option) => option.value === current) || options[0];
    label.textContent = found ? found.label : '';
    items.forEach((item, index) => {
      item.setAttribute('aria-selected', String(options[index].value === current));
    });
  }

  function setActive(index) {
    active = index;
    items.forEach((item, i) => item.classList.toggle('active', i === index));
  }

  function onOutside(event) {
    if (!wrap.contains(event.target)) close();
  }

  function open() {
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const at = options.findIndex((option) => option.value === current);
    setActive(at >= 0 ? at : 0);
    document.addEventListener('pointerdown', onOutside, true);
  }

  function close() {
    if (list.hidden) return;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    setActive(-1);
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function choose(index) {
    const option = options[index];
    if (!option) return;
    current = option.value;
    paint();
    close();
    trigger.focus();
    if (onChange) onChange(option.value);
  }

  trigger.addEventListener('click', () => (list.hidden ? open() : close()));
  trigger.addEventListener('keydown', (event) => {
    const key = event.key;
    const openKeys = key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp';
    if (openKeys) {
      event.preventDefault(); // 也挡住 Enter/Space 在 button 上合成的那次 click
      if (list.hidden) {
        open();
        if (key === 'ArrowUp') setActive(items.length - 1);
        return;
      }
      if (key === 'Enter' || key === ' ') { choose(active >= 0 ? active : 0); return; }
      if (key === 'ArrowDown') setActive(Math.min(active + 1, items.length - 1));
      else setActive(Math.max(active - 1, 0));
      return;
    }
    if (list.hidden) return;
    if (key === 'Escape' || key === 'Tab') {
      if (key === 'Escape') event.preventDefault();
      close();
    } else if (key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (key === 'End') {
      event.preventDefault();
      setActive(items.length - 1);
    }
  });

  wrap.append(trigger, list);
  paint();
  return {
    node: wrap,
    value: () => current,
    setValue(next) { current = next; paint(); },
  };
}

// --- 换算与展示 ---------------------------------------------------------------

async function runConversion() {
  const def = currentDef();
  const amount = String(byId('amount').value || '').trim();
  const payload = { category: def.id, from: panelState.from, to: panelState.to };
  if (def.kind === 'timezone') payload.time = amount;
  else payload.value = amount;
  try {
    const out = convert(payload, { decimals: cfg.decimals });
    paintResult(out);
    pushRecent(out, amount);
  } catch (err) {
    // convert 的拒绝就是给人看的中文句子：原样显示（不翻译成"出错了"）。
    paintError((err && err.message) || String(err));
  }
}

function paintResult(out) {
  byId('result').hidden = false;
  byId('result-value').textContent = out.text;
  byId('result-unit').textContent = out.unit;
  byId('result-expr').textContent = out.expression;
  const note = byId('result-note');
  note.textContent = out.note || '';
  note.hidden = !out.note;
  const error = byId('error');
  error.hidden = true;
  error.textContent = '';
}

function paintError(message) {
  byId('result').hidden = true;
  const node = byId('error');
  node.hidden = false;
  node.textContent = message;
}

function pushRecent(out, amount) {
  const row = { category: out.category, from: out.from, to: out.to, amount, expression: out.expression };
  // 同一条换算（同样的表达式）只留最新那次：反复按「换算」不该把列表刷满。
  panelState.recent = panelState.recent.filter((item) => item.expression !== row.expression);
  panelState.recent.unshift(row);
  if (panelState.recent.length > 8) panelState.recent.length = 8;
  renderRecent();
}

function renderRecent() {
  const list = byId('recent');
  list.textContent = '';
  for (const row of panelState.recent) {
    const item = el('li', 'recent-row');
    const button = el('button', 'recent-btn');
    button.type = 'button';
    button.append(el('span', 'recent-expr', row.expression));
    button.addEventListener('click', () => guard(() => restoreRecent(row)));
    item.append(button);
    list.append(item);
  }
  const empty = panelState.recent.length === 0;
  byId('recent-empty').hidden = !empty;
  byId('recent-clear').disabled = empty;
}

async function restoreRecent(row) {
  byId('amount').value = String(row.amount);
  await selectCategory(row.category, row);
  await runConversion();
}

/** 记住"上次用的那对单位"。键是相对路径（≤4 段、每段只能是 [A-Za-z0-9_-]），不带扩展名。 */
async function persistUnits() {
  if (!granted.has('storage')) return;
  try {
    const value = { category: panelState.category, from: panelState.from, to: panelState.to };
    await writeJSON('state/last-units', value);
  } catch {
    // 存不住就算了：这是"下次打开省一步"的便利，不是这次换算的前提。
  }
}

// --- 挂载 ---------------------------------------------------------------------

let listenersBound = false;

function bindOnce() {
  if (listenersBound) return;
  listenersBound = true;
  byId('run').addEventListener('click', () => guard(runConversion));
  byId('swap').addEventListener('click', () => guard(async () => {
    const swap = panelState.from;
    panelState.from = panelState.to;
    panelState.to = swap;
    if (fromSelect) fromSelect.setValue(panelState.from);
    if (toSelect) toSelect.setValue(panelState.to);
    await runConversion();
  }));
  byId('amount').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    guard(runConversion);
  });
  byId('recent-clear').addEventListener('click', () => {
    panelState.recent = [];
    renderRecent();
  });
}

async function mountPanel() {
  const conf = await ensureConfig();
  const saved = await readJSON('state/last-units', null);

  const notes = [];
  let wanted = String((saved && saved.category) || conf.defaultCategory || 'length');
  let def = CATEGORY_LIST.find((item) => item.id === wanted);
  if (!def) {
    // 默认分类被手改成了表里没有的值：回落到长度，并把这件事说出来（静默回落会让人以为设置没保存）。
    notes.push(`设置里的默认分类「${wanted}」不认识，已回到「${CATEGORY_LIST[0].label}」`);
    def = CATEGORY_LIST[0];
  }
  if (def.id === 'currency' && !conf.showRates) def = CATEGORY_LIST[0];
  if (!granted.has('storage')) {
    notes.push('没有 storage 授权：最近换算只留在内存里，也不会记住上次用的那对单位');
  }

  panelState.category = def.id;
  buildTabs();
  bindOnce();
  // 打开就先算一遍示例：用户看到的是一个有结果的页面，而不是空框 + 一个按钮。
  await selectCategory(def.id, saved, true);
  renderRecent();
  say(notes.join('　'));
}
