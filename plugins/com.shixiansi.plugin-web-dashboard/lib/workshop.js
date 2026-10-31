// lib/workshop.js —— 工坊页渲染 + 反向控制（经共享键下发命令）
//
// 看板的"反向控制"不是 plugin.call（todo/pomodoro 不接受命令），而是和
// pomodoro/voice-call 相同的约定：写一个共享命令键，目标插件的常驻帧轮询它。
// 番茄钟自己已经读 SHARE_COMMAND（pomodoro/app.js 的 readCommand），
// 所以看板写**同一个键名**就是番茄钟听得懂的话。
//
// 页面结构：数据卡（待办/番茄钟/对话）+ 纯 CSS 柱状图 + 命令按钮。

'use strict';

function renderWorkshop() {
  renderCards();
  renderStatus();
}

function renderStatus() {
  if (!els.chipState) return;
  const data = lastData;
  els.chipState.textContent = data ? `看板 · 更新于 ${new Date(data.at).toLocaleTimeString()}` : '看板 · 尚未采集';
  if (els.statusError) els.statusError.textContent = lastError || '';
  if (els.statusNote) els.statusNote.textContent = lastError ? '' : '数据由各插件现答（stats），每 30 秒刷新一次。';
  if (els.refreshNow) {
    els.refreshNow.disabled = false;
  }
}

/** 一张数据卡：标题、值、副行。null 数据显示"未安装"。 */
function cardText(el, title, value, sub) {
  if (!el) return;
  el.replaceChildren();
  const head = document.createElement('h3');
  head.textContent = title;
  el.appendChild(head);
  if (value === null || value === undefined) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '未安装或未启用';
    el.appendChild(empty);
    return;
  }
  const big = document.createElement('p');
  big.className = 'card-big';
  big.textContent = value;
  el.appendChild(big);
  if (sub) {
    const line = document.createElement('p');
    line.className = 'muted';
    line.textContent = sub;
    el.appendChild(line);
  }
}

/**
 * 纯 CSS 柱状图：值数组 → 一排高度按百分比的条。
 * 高度只用 --chart-max 里的百分比，颜色全部来自 token。
 */
function barChart(el, entries, max) {
  if (!el) return;
  el.replaceChildren();
  const entriesArr = Array.isArray(entries) ? entries : [];
  if (!entriesArr.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '暂无数据';
    el.appendChild(empty);
    return;
  }
  const cap = max > 0 ? max : Math.max(...entriesArr.map((e) => e.value), 1);
  for (const entry of entriesArr) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = entry.label;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.min(100, Math.round((entry.value / cap) * 100))}%`;
    track.appendChild(fill);
    const valueEl = document.createElement('span');
    valueEl.className = 'bar-value';
    valueEl.textContent = String(entry.value);
    row.append(label, track, valueEl);
    el.appendChild(row);
  }
}

async function renderCards() {
  const data = await loadLastData();
  if (!data) {
    cardText(els.cardsTodo, '待办', null);
    cardText(els.cardsPomodoro, '专注', null);
    cardText(els.cardsChat, '对话', null);
    barChart(els.barsTodo, []);
    barChart(els.barsPomodoro, []);
    renderStatus();
    return;
  }

  if (data.todo) {
    cardText(els.cardsTodo, '待办', `${data.todo.done}/${data.todo.total}`,
      `完成率 ${data.todo.completionRate}% · 今天到期 ${data.todo.dueToday}`);
    barChart(els.barsTodo, [
      { label: '已完成', value: data.todo.done },
      { label: '进行中', value: data.todo.open },
      { label: '今日到期', value: data.todo.dueToday },
    ]);
  } else {
    cardText(els.cardsTodo, '待办', null);
    barChart(els.barsTodo, []);
  }

  if (data.pomodoro) {
    cardText(els.cardsPomodoro, '专注', `${data.pomodoro.focusMinutesToday} 分钟`,
      `今天 ${data.pomodoro.focusSessions} 个番茄 · 累计 ${data.pomodoro.focusSessionsTotal} 个`);
    barChart(els.barsPomodoro, [
      { label: '今日番茄', value: data.pomodoro.focusSessions },
      { label: '累计番茄', value: data.pomodoro.focusSessionsTotal },
    ]);
  } else {
    cardText(els.cardsPomodoro, '专注', null);
    barChart(els.barsPomodoro, []);
  }

  if (data.chat) {
    cardText(els.cardsChat, '对话', `${data.chat.turns ?? '—'}`,
      data.chat.lastDay ? `最近 ${data.chat.lastDay}` : '');
  } else {
    cardText(els.cardsChat, '对话', null);
  }
  renderStatus();
}

// --- 反向控制 -------------------------------------------------------------------

const POMODORO_ID = 'com.shixiansi.plugin-pomodoro';

/** 番茄钟听得懂的命令键（它自己的 readCommand 轮询这个键）。 */
async function sendPomodoroCommand(op) {
  try {
    await request('share.set', { name: 'pomodoro-command', value: JSON.stringify({ op, at: now() }) });
    say(`已向番茄钟下发命令：${op}`);
  } catch (err) {
    say(`命令没有发出去：${text(err && err.message, 120)}`);
  }
}

async function sayHi() {
  if (!flag('showBubble', true) || !granted.has('pet.bubble')) return;
  try {
    await request('bubble.say', { text: '我在看着你的看板呢。' });
  } catch (err) {
    say(`气泡没有弹出来：${text(err && err.message, 120)}`);
  }
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

/** 采集 + 渲染（工坊页的定时刷新与按钮共用）。 */
async function refreshNow() {
  lastError = '';
  await collectOnce();
  await renderCards();
}
