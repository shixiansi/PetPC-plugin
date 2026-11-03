// lib/view.js —— 三个角色各自画什么，以及只能住在一个角色里的两件事。
//
// 为什么"头顶那行字"和"到点提醒"都归常驻帧（role === 'bg'）：
//
//   * 一个文档一个写者。三个帧都会重画，谁都能推 `pet.badge` 的话，这一行字会在"连续 12 天"
//     与"今天还差 2 件"之间闪；而常驻帧是**唯一一直在**的那个（卡片关了就没了）。
//   * 提醒是钟表：卡片与插件页随时会被关掉，关掉之后到点也该提醒。
//
// 卡片与插件页只做两件事：画，以及把用户点的那一下写进存储。

'use strict';

// --- 宠物头顶那一行字 ---------------------------------------------------------

let pushedBadge = null; // 上一次推上去的文字（null = 还没推过）
let remindedDay = ''; // 这一帧里提醒过的日子（落盘失败时的兜底，见 checkReminder）

function pushBadge() {
  if (role !== 'bg' || !canPet()) return; // 没授权就一个请求都不发
  const wanted = badgeText(emptyOrState(), nowMs(), cfg.badgeMode);
  // 只在这个"看得见的文字"变了的时候推：每 30 秒推一次同一个串，宿主日志里全是同一行。
  if (wanted === pushedBadge) return;
  pushedBadge = wanted;
  request('pet.badge', { text: wanted }).catch(() => {
    // 被拒 / 断线：下一次有机会再说。不把 pushedBadge 当成"已经说过了"，
    // 否则那次失败会一直静音到文字恰好变一次为止。
    pushedBadge = null;
  });
}

/**
 * 到点提醒。同一"习惯日"只提醒一次——判据是 storage 里的 `lastRemindDay`：
 * 定时器每 30 秒看一次，没有它就会在到点之后的每一拍各提醒一次；而帧被重挂
 * （改授权、换版本）之后内存里什么都不剩，所以这条必须跟着状态落盘。
 */
async function checkReminder() {
  if (role !== 'bg') return;
  if (!configOn(cfg.remindEnabled)) return;
  // 提醒的两条腿都要 `pet.surface`（`pet.badge` 借它、`surface.show` 就是它）。没有授权时
  // 提醒没有任何东西可以显示，所以整条路径都不发请求、也不写"今天提醒过了"。
  if (!canPet()) return;
  const now = nowMs();
  const day = dayKey(now);
  if (remindedDay === day) return;
  if (!reminderDue(emptyOrState(), now, cfg.remindAt)) return;
  remindedDay = day; // 先记在内存里：存储写不进去也不会在每一拍重复提醒
  await applyChange((s) => {
    if (s.lastRemindDay === day) return null;
    s.lastRemindDay = day;
    return s;
  });
  // 提醒长什么样：把宠物旁那块卡片打开（`surface.show`），用户一眼看见今天还差几件。
  //
  // **为什么没有气泡**：提醒走头顶那行字 + 卡片，不申请 `pet.bubble`——少一项权限换同样的效果，
  // 而且气泡与浮层面共用宠物旁边那个位置，弹一个气泡会把用户正在看的那张卡片顶掉。
  // 只有 `pet.surface` 一份授权就够（`pet.badge` 与 `surface.show` 都借它）。
  if (granted.has('pet.surface') && serves('surface.show')) {
    try {
      await request('surface.show', {});
    } catch {
      // 打不开卡片也不算失败：头顶那行字还在，卡片下次点开也一样。
    }
  }
  pushBadge();
  renderAll();
}

// --- plugin.call 的答案 -------------------------------------------------------

/** 一个方法一条答案。未知方法抛一句中文——外层会把它原样回给调用方。 */
async function serveAnswer(method) {
  await refreshState(); // 别的文档可能刚打过卡：回答前重读一次
  const now = nowMs();
  const current = emptyOrState();
  if (method === 'streak') {
    const info = streakInfo(current, now);
    return { streak: info.streak, lastDay: info.lastDay, best: info.best };
  }
  if (method === 'today') {
    const today = todayInfo(current, now);
    return { day: today.day, items: today.items, pending: today.pending };
  }
  throw new Error(`习惯打卡不认识 ${method} 这个方法（它只答 streak 与 today）`);
}

// --- 宠物旁边那块卡片 ---------------------------------------------------------

function cardNoteText() {
  if (!granted.has('pet.surface')) return '头顶那行字需要「在桌宠身上显示」这项授权';
  if (!granted.has('storage')) return '没有存储授权，打卡记不下来';
  const today = todayInfo(emptyOrState(), nowMs());
  if (!today.items.length) return '还没有习惯：去「习惯打卡」页添加';
  if (!today.pending) return '今天的都打完了，明天见';
  if (emptyOrState().lastRemindDay === today.day) return `${cfg.remindAt} 已经提醒过了`;
  return '';
}

function renderCard() {
  if (!els.card) return;
  const now = nowMs();
  const current = emptyOrState();
  const today = todayInfo(current, now);
  const info = streakInfo(current, now);

  if (els.cardStreak) {
    // 顶部那一行：连续天数。0 天时不说"连续 0 天"——那句话没有信息，还占掉一半宽度。
    els.cardStreak.textContent = info.streak > 0 ? `连续 ${info.streak} 天` : '还没连上';
  }
  if (els.cardMeta) {
    els.cardMeta.textContent = today.items.length
      ? today.pending > 0
        ? `还差 ${today.pending} 件`
        : '今天打完了'
      : '';
  }

  const note = cardNoteText();
  if (els.cardList) {
    els.cardList.textContent = '';
    // 只列今天还没打的：卡片是 280×140 的声明矩形，多一行就少一行。
    for (const item of today.items.filter((x) => !x.done)) {
      if (!granted.has('storage')) break;
      const row = el('button', 'row');
      row.type = 'button';
      row.dataset.id = item.id;
      row.dataset.act = 'done';
      row.appendChild(el('span', 'row-name', item.name));
      row.appendChild(el('span', 'row-do', '打卡'));
      els.cardList.appendChild(row);
    }
  }
  if (els.cardNote) {
    els.cardNote.textContent = note;
    els.cardNote.hidden = !note;
  }
}

// --- 控制中心的插件页 ---------------------------------------------------------

function renderPage() {
  if (!els.page) return;
  const now = nowMs();
  const current = emptyOrState();
  const today = todayInfo(current, now);
  const info = streakInfo(current, now);

  if (els.statStreak) els.statStreak.textContent = `连续 ${info.streak} 天`;
  if (els.statBest) els.statBest.textContent = `最长 ${info.best} 天`;
  if (els.statPending) {
    els.statPending.textContent = today.items.length
      ? today.pending > 0
        ? `今天还差 ${today.pending} 件`
        : '今天打完了'
      : '今天还没有习惯';
  }

  if (els.todayList) {
    els.todayList.textContent = '';
    for (const item of today.items) {
      const row = el('li', item.done ? 'task done' : 'task');
      const button = el('button', 'check');
      button.type = 'button';
      button.dataset.id = item.id;
      button.dataset.act = item.done ? 'undo' : 'done';
      button.textContent = item.done ? '已打卡' : '打卡';
      row.appendChild(button);
      row.appendChild(el('span', 'name', item.name));
      els.todayList.appendChild(row);
    }
    if (els.todayEmpty) els.todayEmpty.hidden = today.items.length > 0;
  }

  if (els.habitList) {
    els.habitList.textContent = '';
    for (const habit of habitsOf(current)) {
      const row = el('li', 'habit');
      row.appendChild(el('span', 'name', habit.name));
      const drop = el('button', 'drop');
      drop.type = 'button';
      drop.dataset.id = habit.id;
      drop.dataset.act = 'remove';
      drop.textContent = '删除';
      row.appendChild(drop);
      els.habitList.appendChild(row);
    }
    if (els.habitsEmpty) els.habitsEmpty.hidden = habitsOf(current).length > 0;
  }

  if (els.badgeNote) els.badgeNote.textContent = badgeNoteText(current, info);
  if (els.remindNote) els.remindNote.textContent = remindNoteText();
  if (els.addName) els.addName.disabled = !granted.has('storage');
}

/**
 * 头顶那行字的说明。三句话，各自对应一种真实状态：
 * 没授权（说清缺哪一项）、这个窗口没有宠物（说清去哪看）、有的话就把现在会写什么念一遍。
 */
function badgeNoteText(current, info) {
  if (!granted.has('pet.surface')) return '头顶那行字需要「在桌宠身上显示」这项授权';
  if (!serves('pet.badge')) {
    return '头顶那行字与宠物旁的打卡卡片只在桌宠上显示（这里是控制中心的插件页，它没有宠物）';
  }
  const text = badgeText(current, nowMs(), cfg.badgeMode);
  return text ? `头顶那行字：${text}` : '头顶那行字现在是空的（还没有习惯）';
}

function remindNoteText() {
  if (!configOn(cfg.remindEnabled)) return '到点提醒已关闭（在设置里可以打开）';
  // 控制中心这一面既不服务 `surface.show` 也不服务 `pet.badge`——所以这一行只说明"这件事在
  // 桌宠上"，而不是让用户对着一个永远不会响的提醒干等。
  if (!canPet()) {
    return `每天 ${cfg.remindAt} 的提醒在桌宠上：那时它会把宠物旁的卡片叫到眼前，并在头顶那行字上写还差几件。`;
  }
  return `每天 ${cfg.remindAt} 还没打完就提醒一次（一天最多一次）：把宠物旁的卡片叫到眼前，并在头顶那行字上写还差几件。`;
}

function renderAll() {
  if (role === 'page') renderPage();
  else if (role === 'card') renderCard();
}

// --- 点击 ---------------------------------------------------------------------

let wired = false;

function habitId() {
  return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function toggleItem(id) {
  const next = await applyChange((s) => toggleDone(s, id, nowMs()));
  // 同一格重复点一下是幂等的：`toggleDone` 已经把它变成"没有改动"，这里也就什么都不做。
  if (next) {
    renderAll();
    pushBadge();
  }
}

async function removeItem(id) {
  const next = await applyChange((s) => removeHabit(s, id));
  if (next) {
    renderAll();
    pushBadge();
  }
}

async function addItem(name) {
  if (!String(name || '').trim()) {
    say('习惯名不能是空的');
    return;
  }
  const next = await applyChange((s) => addHabit(s, name, habitId()));
  if (!next) {
    say('加不上：这个名字或 id 已经有了');
    return;
  }
  if (els.addName) els.addName.value = '';
  say('');
  renderAll();
  pushBadge();
}

function wire() {
  if (wired) return;
  wired = true;
  const onClick = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('button[data-act]');
    if (!button) return;
    const id = button.dataset.id || '';
    const act = button.dataset.act || '';
    if (!id) return;
    event.preventDefault();
    if (act === 'remove') void removeItem(id);
    else void toggleItem(id);
  };
  for (const node of [els.cardList, els.todayList, els.habitList]) {
    if (node) node.addEventListener('click', onClick);
  }
  if (els.addForm) {
    els.addForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void addItem(els.addName ? els.addName.value : '');
    });
  }
}
