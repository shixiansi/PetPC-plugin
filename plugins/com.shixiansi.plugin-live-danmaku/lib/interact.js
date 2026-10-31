// lib/interact.js —— 节流互动循环：抽取 → 问记忆核心 → 气泡/语音
//
// 每一拍（interactIntervalSec）做一次：
//
//   1. queue.drain：按分挑出最多 N 条值得回的弹幕；
//   2. 合成一句"观众在说"的提示文本（≤4000 字，llm.chat 的硬上限）；
//   3. plugin.call('chat') 交给记忆核心——人设、会话记忆都住在那边，这里不复制；
//      弹幕的会话键是 live-<房间号>，所以同一个直播间的来回是连续的；
//   4. 回应按开关分发：bubble.say（桌宠气泡）与语音（TTS 服务 → audio.save → audio.play）。
//
// WHY 走记忆核心而不是自己 llm.chat
//
// 互动要"接得住上文"：观众上一轮问了什么、主播答了什么，都该进同一份会话记忆。
// plugin.call 的 30 秒超时对"答一句弹幕"足够；它失败时循环**不退出**——直播不因
// 一次调用失败而停。
//
// WHY 回应限量
//
// maxRepliesPerMinute 是打断观众聊天的总闸：模型再快，一秒钟回三句也像复读机。
// 计数器是滑动窗口（毫秒时间戳数组），不是"每分钟清零的桶"。

'use strict';

const interactState = {
  timer: null,
  running: false,
  lastTickAt: 0,
  /** 滑动窗口：最近一分钟每次成功互动的时间戳。 */
  recentReplies: [],
  /** 累计统计（workshop 显示；不持久化——重启清零是可接受的诚实）。 */
  counters: { replies: 0, llmCalls: 0, interactions: 0, ttsOk: 0, ttsFail: 0 },
  lastError: '',
};

function interactRunning() {
  return interactState.running;
}

/**
 * 启动循环。第一个抽取拍不等待：立即试一次（队列里有东西就直接走）。
 */
function startInteractLoop() {
  if (interactState.timer) return;
  interactState.running = true;
  interactState.lastError = '';
  void interactTick();
  scheduleInteract();
}

function scheduleInteract() {
  if (interactState.timer) clearTimeout(interactState.timer);
  const everySec = num('interactIntervalSec', 2, 600, 5);
  interactState.timer = setTimeout(() => {
    interactState.timer = null;
    if (!interactState.running) return;
    void interactTick().finally(scheduleInteract);
  }, Math.max(1, everySec) * 1000);
}

function stopInteractLoop() {
  interactState.running = false;
  if (interactState.timer) {
    clearTimeout(interactState.timer);
    interactState.timer = null;
  }
}

/**
 * 一拍互动。返回本次的互动记录（或 null：没抽到 / 限流挡住 / 队列是空的）。
 *
 * 每一步失败都只记 interactState.lastError——直播循环不能因为一次调用失败而停。
 */
async function interactTick() {
  if (!interactState.running) return null;
  interactState.lastTickAt = now();
  const limit = num('maxRepliesPerMinute', 0, 60, 6);
  if (limit <= 0) {
    // 只看不回：队列照常抽取（保持统计准确），但什么都不发。
    DanmakuQueue.drain(queue, 0, now());
    return null;
  }
  if (!withinRate(limit)) {
    return null;
  }

  const picked = DanmakuQueue.drain(queue, num('maxBatch', 1, 5, 1), now());
  if (!picked.length) return null;
  interactState.counters.interactions += 1;

  const line = buildPrompt(picked);
  let answer = '';
  try {
    const out = await request('plugin.call', {
      target: 'com.shixiansi.plugin-memcore',
      method: 'chat',
      payload: {
        roleId: memcoreRoleKey(),
        userId: picked[0].uid || 'live-audience',
        userName: picked[0].name || '观众',
        text: line,
      },
    });
    interactState.counters.llmCalls += 1;
    answer = String((out && out.text) || '').trim();
  } catch (err) {
    interactState.lastError = `记忆核心没有回答：${text(err && err.message, 120)}`;
    return null;
  }
  if (!answer) {
    interactState.lastError = '记忆核心返回了空回应';
    return null;
  }

  interactState.recentReplies.push(now());
  interactState.counters.replies += 1;
  // 记录与回应显示都是"射后不理"：tick 的返回值是这次互动的摘要，不该被
  // 存储往返的时序拖住（更不该因为日志写失败而把它变成 null）。
  void recordReply(picked, answer);
  renderReplies();

  await deliverReply(answer);
  return { prompt: line, answer, picked };
}

/** 滑动窗口限流：60 秒内的回应次数 < maxRepliesPerMinute 才放行。 */
function withinRate(limit) {
  const cutoff = now() - 60000;
  interactState.recentReplies = interactState.recentReplies.filter((at) => at > cutoff);
  return interactState.recentReplies.length < limit;
}

/** 把一批弹幕压成一条提示文本。超长时从最旧的开始丢——最新的那句话最要紧。 */
function buildPrompt(picked) {
  const persona = text(cfg.persona, 200).trim();
  const lines = [];
  lines.push(`（直播间弹幕，现在 ${picked.length} 条值得回应）`);
  for (const item of picked) {
    const repeated = item.count > 1 ? `（这条被刷了 ${item.count} 遍）` : '';
    lines.push(`${item.name}：${item.text}${repeated}`);
  }
  lines.push('请以主播身份简短回应最近的一条（或几条），不超过 60 字，口语化，不要念弹幕原文。');
  if (persona) lines.unshift(`主播人设：${persona}`);
  let body = lines.join('\n');
  while (Array.from(body).length > 3800 && picked.length > 1) {
    picked.shift();
    body = buildPrompt(picked);
  }
  return body;
}

/** 回应的去处：气泡（桌宠）与语音（TTS → audio）。两个都关时只记账。 */
async function deliverReply(answer) {
  const tasks = [];
  if (flag('bubbleEnabled', true) && granted.has('pet.bubble')) {
    tasks.push(sayBubble(answer));
  }
  if (flag('speakEnabled', false)) {
    tasks.push(speakReply(answer));
  }
  await Promise.all(tasks.map((p) => p.catch((err) => {
    interactState.lastError = text(err && err.message, 120);
  })));
}

async function sayBubble(answer) {
  try {
    await request('bubble.say', { text: text(answer, 120) });
  } catch (err) {
    interactState.lastError = `气泡没有弹出来：${text(err && err.message, 120)}`;
  }
}

// --- 语音 ---------------------------------------------------------------------
//
// 与 voice 插件同一个 TTS 形状（GPT-SoVITS）：GET 两次权重、POST /tts 拿 base64 WAV、
// audio.save 落一份、audio.play 播放。这里不复用 voice 插件的代码——那是另一个沙箱
// 文档，没有共享内存（手册 §1）；形状一致本身就是兼容。

let ttsSeq = 0;

async function speakReply(answer) {
  const base = String(cfg.voiceBaseUrl || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const refPath = String(cfg.voiceRefPath || '').trim();
  if (!base || !refPath) {
    interactState.lastError = '想说话但语音配置不完整（需要语音服务地址与参考音频路径）';
    interactState.counters.ttsFail += 1;
    return;
  }
  const seq = `dm-${(ttsSeq += 1)}`;
  const body = JSON.stringify({
    text: text(answer, 200),
    text_lang: 'zh',
    ref_audio_path: refPath,
    prompt_text: String(cfg.voicePromptText || ''),
    prompt_lang: 'zh',
    speed_factor: 1,
    streaming_mode: false,
  });
  try {
    const out = await request('net.fetch', { url: `http://${base}/tts`, method: 'POST', encoding: 'base64', body });
    if (!out || out.status !== 200 || !out.body) {
      interactState.lastError = `语音服务返回 ${out ? out.status : '无响应'}`;
      interactState.counters.ttsFail += 1;
      return;
    }
    const name = keyOf(`live-${seq}`, 'live-clip');
    await request('audio.save', { name, data: out.body });
    await request('audio.play', { name });
    interactState.counters.ttsOk += 1;
  } catch (err) {
    interactState.lastError = `语音失败：${text(err && err.message, 120)}`;
    interactState.counters.ttsFail += 1;
  }
}

// --- 记录 ---------------------------------------------------------------------

const REPLY_LOG_KEY = 'state/replies';
const MAX_REPLIES = 40;

/** 一条回应记进私有存储（工坊页显示最近几条；重启还在）。 */
async function recordReply(picked, answer) {
  try {
    const log = await readJSON(REPLY_LOG_KEY, []);
    const entry = {
      at: now(),
      day: today(),
      prompt: picked.map((p) => `${p.name}：${p.text}`).join(' / '),
      answer,
    };
    const next = (Array.isArray(log) ? log : []).concat([entry]).slice(-MAX_REPLIES);
    await writeJSON(REPLY_LOG_KEY, next);
  } catch {
    // 日志写不进去不该打断互动。
  }
}

/** 记忆核心的会话键：同一个直播间共用一份上下文。 */
function memcoreRoleKey() {
  const room = keyOf(roomLabel() || '0', '0');
  return `live-${room}`;
}

/** 工坊页读最近几条回应。没有 storage 权限就不发请求（界面停在"未授权"，不是半截）。 */
async function loadReplies() {
  if (!granted.has('storage')) return [];
  const log = await readJSON(REPLY_LOG_KEY, []);
  return (Array.isArray(log) ? log : []).slice(-12).reverse();
}
