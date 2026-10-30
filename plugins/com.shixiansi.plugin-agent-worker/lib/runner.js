// lib/runner.js —— 执行器：拆解 → 执行 → 状态发布 → 播报
//
// 一次 pollOnce：
//
//   1. recoverOrphans 已经在启动时做过（断点恢复）；
//   2. pickNextTask 取第一个 pending → markRunning（写盘）；
//   3. 发布 agent/status {status:'working', progress}（桌宠显示「搬砖」）；
//   4. 执行：把任务描述交给记忆核心的 chat，让它给出"执行结果"——这是沙箱插件
//      唯一诚实的执行模型：宿主不认识任意进程，模型驱动的"查资料/写总结/整理清单"
//      才是能落地的任务本体（真正动本机的活儿有 process 权限的专职插件）；
//   5. 成功 → markDone；失败/超时 → markFailed（自动重试一次）；
//   6. announce 开着时经 memcore/chat 播报一句结果；
//   7. 清掉 agent/status。
//
// 并发纪律：**单飞**。pollTick 上一轮没跑完就不再进入（pollBusy 标志）——
// 5 分钟的检查间隔只是兜底，任务真正是背靠背串行的。

'use strict';

const MEMCORE_TARGET = 'com.shixiansi.plugin-memcore';
const MEMCORE_METHOD = 'chat';
const AGENT_ROLE = 'agent-worker';

/** 共享键：桌宠读这个显示「搬砖」。 */
const SHARE_STATUS = 'agent/status';

/** 执行一个任务：问记忆核心，拿一段"执行结果"文本。 */
async function executeTask(task, timeoutSec) {
  const budget = clampInt(timeoutSec, 30, 600, 120) * 1000;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`任务执行超时（${Math.round(budget / 1000)} 秒）`)), budget);
  });
  try {
    const out = await Promise.race([
      request('plugin.call', {
        target: MEMCORE_TARGET,
        method: MEMCORE_METHOD,
        payload: {
          roleId: AGENT_ROLE,
          userId: 'desktop',
          userName: '主人',
          text: `请把下面这件后台任务做完，并把结果整理成一段可以直接交给主人的话：\n${task.description}`,
          hint: '这是后台任务执行请求：直接给出任务的结果，不要反问',
        },
      }),
      timeout,
    ]);
    const reply = out && typeof out.text === 'string' ? out.text : '';
    if (!reply.trim()) throw new Error('记忆核心没有返回内容（检查它的模型配置）');
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

/** 发布执行状态（桌宠的「搬砖」状态卡）。 */
async function publishStatus(status) {
  if (!flag('showStatus', true) || !granted.has('plugin.share')) return;
  try {
    await request('share.set', { name: SHARE_STATUS, value: JSON.stringify(status) });
  } catch {
    // 牌盘写不进去不影响执行。
  }
}

/** 播报一句结果（经记忆核心；它记得上下文，播报也有人设）。 */
async function announce(line) {
  if (!flag('announce', true)) return;
  try {
    await request('plugin.call', {
      target: MEMCORE_TARGET,
      method: MEMCORE_METHOD,
      payload: {
        roleId: AGENT_ROLE,
        userId: 'desktop',
        userName: '系统',
        text: `[系统通知] ${line}`,
        hint: '系统通知：向主人简短播报这一句，可以带点人设',
      },
    });
  } catch {
    // 播报失败不影响任务本身。
  }
}

/** 一轮完整执行：取一个任务、跑完、记账。返回执行摘要或 null（队列空）。 */
async function runOneTask() {
  await refreshConfig();
  const tasks = await loadTasks();
  const picked = pickNextTask(tasks);
  if (!picked) return null;

  const running = await markRunning(picked);
  if (!running) return null; // 状态已被改动（单写者下不该发生）

  const queueLeft = (await loadTasks()).filter((t) => t.status === 'pending' || t.status === 'running').length;
  await publishStatus({
    status: 'working',
    progress: Math.round(((queueLeft - 1) / Math.max(queueLeft, 1)) * 100),
    taskId: running.id,
    note: text(running.description, 60),
    at: now(),
  });

  let result = '';
  let error = '';
  try {
    result = await executeTask(running, num('execTimeoutSec', 30, 600, 120));
    await markDone(running.id, result);
    await announce(`后台任务 ${running.id} 完成了：${text(result, 120)}`);
  } catch (err) {
    error = text(err && err.message ? err.message : err, 400);
    await markFailed(running.id, error);
    await announce(`后台任务 ${running.id} 失败了：${error}`);
  } finally {
    await publishStatus({ status: 'idle', progress: 0, taskId: '', note: '', at: now() });
  }

  const after = await loadTasks();
  return {
    id: running.id,
    status: (after.find((t) => t.id === running.id) || {}).status || 'done',
    error,
    queue: summarize(after),
  };
}

/**
 * 排空队列（测试与"立刻跑一轮"用）：背靠背串行执行直到没有 pending。
 * 单飞保证在 pollTick 里由 pollBusy 提供；这里本来就是同步排空。
 */
async function drainQueue() {
  const ran = [];
  for (;;) {
    const outcome = await runOneTask();
    if (!outcome) break;
    ran.push(outcome);
    // failed 的终态不再跑；pending（重试）继续。
    if (outcome.status !== 'done' && outcome.status !== 'failed') continue;
    if (outcome.status === 'failed') continue; // 终态，跳过但继续看下一个
  }
  return ran;
}

// --- 定时器 -----------------------------------------------------------------------

let pollTimer = null;
let pollBusy = false;

/** 每 pollSec 秒检查一次队列；上一轮没跑完就跳过这一拍（单飞）。 */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const sec = num('pollSec', 60, 3600, 300);
  pollTimer = setInterval(() => {
    void pollTick().catch(() => {});
  }, sec * 1000);
}

async function pollTick() {
  if (pollBusy) return null;
  pollBusy = true;
  try {
    return await runOneTask();
  } finally {
    pollBusy = false;
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
