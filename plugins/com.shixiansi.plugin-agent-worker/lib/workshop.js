// lib/workshop.js —— 插件页那一面：提交任务 + 队列一览 + 立刻跑一轮
//
// 纪律与 websearch / diary 的 workshop 同一条：控制中心不服务 plugin.call，
// 「立刻跑一轮」按钮在这一页禁用；队列一览（storage 只读）照常显示。

'use strict';

let running = false;

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

const STATUS_LABEL = {
  pending: '排队中',
  running: '执行中',
  done: '完成',
  failed: '失败',
};

/** 提交一个任务（面板按钮）。 */
async function submitTask() {
  if (!els.taskText) return;
  const description = String(els.taskText.value || '').trim();
  if (!description) {
    say('先写一句话描述要做的事');
    return;
  }
  try {
    const out = await enqueueTask({ task_description: description });
    els.taskText.value = '';
    say(`已入队（${out.id}），前面还有 ${Math.max(0, out.queueLength - 1)} 个任务`);
    void renderQueue();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 200));
  }
}

/** 「立刻跑一轮」。 */
async function runOnce() {
  if (running) return;
  running = true;
  if (els.runOnce) els.runOnce.disabled = true;
  say('执行中…');
  try {
    const ran = await drainQueue();
    say(ran.length ? `这一轮跑了 ${ran.length} 个任务` : '队列是空的');
    void renderQueue();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 200));
  } finally {
    running = false;
    if (els.runOnce) els.runOnce.disabled = !granted.has('plugin.call');
  }
}

/** 队列一览。 */
async function renderQueue() {
  if (!els.queueList) return;
  const tasks = await loadTasks();
  els.queueList.textContent = '';
  const visible = tasks.slice().reverse().slice(0, 30);
  if (!visible.length) {
    if (els.queueEmpty) els.queueEmpty.classList.remove('hidden');
    return;
  }
  if (els.queueEmpty) els.queueEmpty.classList.add('hidden');
  for (const task of visible) {
    const row = el('div', 'task');
    const head = el('div', 'task-head');
    head.append(el('span', `task-status st-${task.status}`, STATUS_LABEL[task.status] || task.status));
    head.append(el('span', 'task-id', task.id));
    row.append(head);
    row.append(el('p', 'task-desc', text(task.description, 160)));
    const bits = [`提交 ${fmtTime(task.createdAt)}`, `尝试 ${task.attempts || 0} 次`];
    if (task.status === 'done' && task.result) bits.push(text(task.result, 60));
    if (task.status === 'failed' && task.error) bits.push(task.error);
    row.append(el('p', 'task-meta', bits.join(' · ')));
    els.queueList.append(row);
  }
}
