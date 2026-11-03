// lib/workshop.js —— 控制中心的整页：完整清单、加一条、删一条
//
// 这一面**没有宠物**：宿主不服务 bubble.say / surface.* / pet.badge / plugin.call
// （init.host.methods 里就没有它们，别硬发——那会变成一行没人看的"本程序不支持该方法"，手册 §9）。
// 所以这里不画"现在头顶写着什么"的控件，只用 #ws-note 说清那句话在桌宠上；清单本身照常可读可
// 写，那是用户打开这一页的原因。三个设置项由**宿主的设置表单**绘制，这里不再重复一遍表单。

'use strict';

let workshopBound = false;
let workshopStatus = '';
let workshopBusy = false;

function bindWorkshop() {
  if (workshopBound) return;
  workshopBound = true;

  if (els.wsAdd) els.wsAdd.addEventListener('click', () => void workshopAdd());
  for (const input of [els.wsName, els.wsDate]) {
    if (!input) continue;
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void workshopAdd();
    });
  }
  if (els.wsList) {
    // 事件委托：清单每次重画都是新的 li，逐个 bind 迟早漏一个，而且会随重画泄漏监听器。
    els.wsList.addEventListener('click', (event) => {
      const button = event.target && event.target.closest ? event.target.closest('[data-remove]') : null;
      if (!button) return;
      const index = Number.parseInt(String(button.getAttribute('data-remove')), 10);
      if (Number.isFinite(index)) void workshopRemove(index);
    });
  }
}

async function workshopSave(nextList) {
  if (workshopBusy) return false;
  workshopBusy = true;
  const ok = await writeKey(KEY_LIST, Agenda.serializeList(nextList));
  workshopBusy = false;
  if (!ok) {
    workshopStatus = '写不进去：check 一下 storage 授权（清单存在插件自己的私有目录里）。';
    return false;
  }
  state.list = nextList;
  state.agenda = Agenda.build(state.list, Dates.todayISO(new Date()));
  return true;
}

async function workshopAdd() {
  if (!can('storage')) {
    workshopStatus = '未获授权：storage（清单存在插件自己的私有目录里）';
    paint();
    return;
  }
  const name = els.wsName ? String(els.wsName.value || '') : '';
  const date = els.wsDate ? String(els.wsDate.value || '') : '';
  const yearly = els.wsYearly ? els.wsYearly.checked === true : true;

  if (!Agenda.cleanName(name)) {
    workshopStatus = '给它起个名字：生日、结婚纪念日、入职那天……';
  } else if (!date.trim()) {
    workshopStatus = '先选一个日期（每年重复的条目只借它的月和日）。';
  } else if (!Dates.parts(date)) {
    // 2 月 29 日是唯一的例外：它只在闰年存在。系统的日期控件会先把不合法的日子拒掉，这条多半只在
    // 别处拼出来的值上出现——但它必须说清楚该怎么办，而不是"日期不对"。
    workshopStatus = /^\d{4}-0?2-0?29$/.test(date.trim())
      ? '2 月 29 日只在闰年出现：把年份写成某个闰年（例如 2028），它就表示「每年 2 月 29 日」。'
      : '日期不对：需要一个真实存在的日子（例如 2026-05-20）。';
  } else {
    const entry = Agenda.normalizeEntry({ name, date, yearly });
    const duplicated =
      entry &&
      state.list.some((row) => row.name === entry.name && row.date === entry.date && row.yearly === entry.yearly);
    if (!entry) {
      workshopStatus = '这一条读不出来：检查一下名称与日期。';
    } else if (duplicated) {
      workshopStatus = '这条已经在清单里了（同名、同一天、同样的重复设置）。';
    } else {
      workshopStatus = '正在保存…';
      paint();
      if (await workshopSave(state.list.concat([entry]))) {
        const p = Dates.parts(entry.date);
        workshopStatus = entry.yearly
          ? '加好了：' + entry.name + '（每年 ' + p.m + ' 月 ' + p.d + ' 日）'
          : '加好了：' + entry.name;
        if (els.wsName) els.wsName.value = '';
      }
      paint();
      if (els.wsName) els.wsName.focus();
      return;
    }
  }
  paint();
}

async function workshopRemove(index) {
  if (!can('storage') || !(index >= 0 && index < state.list.length)) return;
  const removed = state.list[index];
  workshopStatus = '正在删除…';
  paint();
  const saved = await workshopSave(state.list.filter((_, i) => i !== index));
  workshopStatus = saved
    ? '删掉了：' + removed.name + '（桌宠头顶下一次重算时跟着变）'
    : '删不掉：check 一下 storage 授权。';
  paint();
}

function paintWorkshop() {
  bindWorkshop();
  const agenda = state.agenda || Agenda.build([], Dates.todayISO(new Date()));
  const rows = agenda.items;
  const canStore = can('storage');

  const summary = rows.length
    ? '共 ' + rows.length + ' 条' + (agenda.nearest ? ' · 最近：' + agenda.nearest.text : '')
    : '';
  textOf(els.wsState, summary);
  textOf(els.wsStatus, workshopStatus);

  // 同一时刻只有一组可见：读不到（有问题）/ 空状态 / 清单。
  const broken = !canStore || Boolean(state.error);
  show(els.wsBad, broken);
  show(els.wsEmpty, !broken && rows.length === 0);
  show(els.wsList, !broken && rows.length > 0);
  if (broken) {
    textOf(
      els.wsBad,
      canStore
        ? '读不到清单：' + state.error + '——这不是"你还没有纪念日"，是这次没读到。'
        : '未获授权：storage（清单存在插件自己的私有目录里）。在控制中心的「插件」页补上授权，然后重开这一页。',
    );
  }

  for (const node of [els.wsAdd, els.wsName, els.wsDate, els.wsYearly]) {
    if (node) node.disabled = !canStore;
  }

  if (!els.wsList) return;
  els.wsList.textContent = '';
  if (broken) return;
  rows.forEach((row, index) => {
    els.wsList.appendChild(workshopRow(row, index, canStore));
  });
}

function workshopRow(row, index, canStore) {
  const li = document.createElement('li');
  li.className = 'ws-row' + (row.days === 0 ? ' ws-row-today' : '');

  const main = document.createElement('div');
  main.className = 'ws-main';

  const name = document.createElement('span');
  name.className = 'ws-name';
  name.textContent = row.name;

  const meta = document.createElement('span');
  meta.className = 'ws-meta';
  const p = Dates.parts(row.date);
  meta.textContent =
    (row.yearly ? '每年 ' + p.m + ' 月 ' + p.d + ' 日' : row.date) + ' · ' + Agenda.relativeText(row.days);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn ghost ws-remove';
  remove.setAttribute('data-remove', String(index));
  remove.textContent = '删掉';
  remove.disabled = !canStore;

  main.appendChild(name);
  main.appendChild(meta);
  li.appendChild(main);
  li.appendChild(remove);
  return li;
}
