// lib/queue.js —— 任务队列：数组、状态机、断点恢复
//
// 队列就是 storage 里的一份 JSON（`queue/tasks`）。**状态是存在盘上的，不在内存里**：
// 常驻帧随时可能被宿主重启，"重启后未完成任务继续执行"的唯一可靠实现就是
// 每次状态变更都立刻写盘，启动时读盘重建。
//
// 任务状态机：
//
//   pending ──runner 取走──> running ──成功──> done
//                               │ ──失败──> pending(attempts=1，等待重试)
//                               │ ──再失败──> failed
//                               └──超时（按 running 开始时刻判）──同失败
//
// 串行执行的保证：**任何时刻最多一个 running**（runner 单飞，不并发取任务）。
// 测试里的"压测"就是对此的验证：10 个任务一口气提交，执行顺序严格等于提交顺序。

'use strict';

const KEY_TASKS = 'queue/tasks';
const KEY_SEQ = 'queue/seq';

const STATUS = ['pending', 'running', 'done', 'failed'];
/** 失败自动重试次数（含首次执行共 2 次尝试）。 */
const MAX_ATTEMPTS = 2;

/** 入参清洗：task_description 必填。 */
function cleanTaskPayload(payload) {
  const description = text(payload && (payload.task_description ?? payload.description), 2000).trim();
  if (!description) throw new Error('add_background_task 需要 task_description：要做的那件事');
  return { description };
}

/** 读整条队列（盘上没有 = 空数组）。 */
async function loadTasks() {
  const list = await readJSON(KEY_TASKS, []);
  return Array.isArray(list) ? list : [];
}

/** 写整条队列。每次状态变更都调它——这就是断点恢复的保证。 */
async function saveTasks(tasks) {
  await writeJSON(KEY_TASKS, tasks);
}

/** 任务序号（持久化，重启后 id 不重置）。 */
async function nextTaskId() {
  const seq = await readJSON(KEY_SEQ, 0);
  const n = (Number(seq) || 0) + 1;
  await writeJSON(KEY_SEQ, n);
  return `t${String(n).padStart(4, '0')}`;
}

/**
 * 提交一个任务（add_background_task 与手动添加走同一条）。
 * 队列满了抛中文——调用方决定怎么讲给用户。
 */
async function enqueueTask(payload, { maxTasks } = {}) {
  const { description } = cleanTaskPayload(payload);
  const tasks = await loadTasks();
  const cap = Number.isFinite(maxTasks) ? maxTasks : 20;
  const active = tasks.filter((t) => t.status === 'pending' || t.status === 'running').length;
  if (active >= cap) {
    throw new Error(`队列满了（${cap} 个未完成任务）：等它们跑完再来`);
  }
  const task = {
    id: await nextTaskId(),
    description,
    status: 'pending',
    attempts: 0,
    createdAt: now(),
    startedAt: 0,
    finishedAt: 0,
    result: '',
    error: '',
  };
  tasks.push(task);
  await saveTasks(tasks);
  return { id: task.id, queueLength: tasks.filter((t) => t.status === 'pending' || t.status === 'running').length };
}

/** 取第一个可执行的任务：严格按提交顺序，跳过不是 pending 的。 */
function pickNextTask(tasks) {
  return tasks.find((t) => t && t.status === 'pending') || null;
}

/** 把一个任务标记为 running（写盘后返回任务）。 */
async function markRunning(task) {
  const tasks = await loadTasks();
  const t = tasks.find((x) => x.id === task.id);
  if (!t || t.status !== 'pending') return null; // 别的执行者已经动过它（单写者下不该发生）
  t.status = 'running';
  t.attempts += 1;
  t.startedAt = now();
  await saveTasks(tasks);
  return t;
}

/** 标记成功。 */
async function markDone(taskId, result) {
  const tasks = await loadTasks();
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return null;
  t.status = 'done';
  t.result = text(result, 4000);
  t.finishedAt = now();
  await saveTasks(tasks);
  return t;
}

/** 标记失败：还有重试机会就回 pending（等下一轮），否则终态 failed。 */
async function markFailed(taskId, error) {
  const tasks = await loadTasks();
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return null;
  t.error = text(error, 500);
  if (t.attempts < MAX_ATTEMPTS) {
    t.status = 'pending'; // 下一轮再试
  } else {
    t.status = 'failed';
    t.finishedAt = now();
  }
  await saveTasks(tasks);
  return t;
}

/**
 * 断点恢复：把上一进程留下的 running 判死（它跑不完——进程都没了），
 * 按剩余重试次数回 pending 或终态 failed。启动时调用一次。
 */
async function recoverOrphans() {
  const tasks = await loadTasks();
  let recovered = 0;
  for (const t of tasks) {
    if (t.status !== 'running') continue;
    t.error = text(t.error || '宿主重启时任务中断', 500);
    if (t.attempts < MAX_ATTEMPTS) {
      t.status = 'pending';
    } else {
      t.status = 'failed';
      t.finishedAt = now();
    }
    recovered += 1;
  }
  if (recovered) await saveTasks(tasks);
  return recovered;
}

/** 队列摘要（工坊页与 queue_status 用）。 */
function summarize(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return {
    total: list.length,
    pending: list.filter((t) => t.status === 'pending').length,
    running: list.filter((t) => t.status === 'running').length,
    done: list.filter((t) => t.status === 'done').length,
    failed: list.filter((t) => t.status === 'failed').length,
  };
}
