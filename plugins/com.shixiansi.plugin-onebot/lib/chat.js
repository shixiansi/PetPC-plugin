// lib/chat.js —— 入站：一帧 → 一个问题 → 一句回答
//
// 这是整个适配器的形状：**判断要不要接、把问题转成 plugin.call、把回答发回去**。它不认识
// 人设，也不存记忆——那两样都在记忆核心里（见 manifest 的 callTargets）。
//
// WHY 要按会话排队
//
// 同一个群里两条消息同时到，如果并发地各调一次 plugin.call，回答的顺序就会取决于模型谁先
// 答完：先问的那句可能后答，读起来像答错了。记忆核心那一侧本来就按 roleId 排队，这里再排
// 一次是为了让**发送顺序**也确定——一道队，两头都稳。

'use strict';

/** 记忆核心的插件 id 与它答的方法。必须与 manifest 的 callTargets 一致。 */
const CORE_TARGET = 'com.shixiansi.plugin-memcore';
const CORE_METHOD = 'chat';

/** 每个会话一条队列（与记忆核心那侧同一个形状，理由见文件头）。 */
const conversationQueues = new Map();

/** 已经处理过的消息 id（协议端重连后会重发），只在内存里留一小段。 */
const seenIds = new Set();

/** learnSelf 正在问协议端：档住第二次并发（ws.state 与 openSocket 都会触发它）。 */
let learningSelf = false;

function serialized(roleKey, job) {
  const previous = conversationQueues.get(roleKey) || Promise.resolve();
  const run = previous.then(job, job);
  conversationQueues.set(roleKey, run.then(() => {}, () => {}));
  return run;
}

/** 计数的默认值。写成一份，是因为读-改-写散落三处时最容易漏掉一个字段。 */
const STATUS_DEFAULTS = { answered: 0, skipped: 0, failed: 0, lastAt: 0, lastError: null };

async function persistStatus(patch) {
  const current = await readJSON('state/status', {});
  const next = Object.assign({}, STATUS_DEFAULTS, current, patch);
  await writeJSON('state/status', next);
  return next;
}

/** 计数 +1（读-改-写一次完成，避免两处各自读一次互相覆盖）。 */
async function bump(field) {
  const current = await readJSON('state/status', {});
  const next = Object.assign({}, STATUS_DEFAULTS, current);
  next[field] = (Number(next[field]) || 0) + 1;
  next.lastAt = now();
  await writeJSON('state/status', next);
  return next;
}

/** 记一个群的"最后活跃"，给插件页用（它不参与任何决定）。 */
async function touchGroup(msg) {
  if (!msg.isGroup) return;
  const groups = await readJSON('state/groups', {});
  const key = msg.groupId;
  const row = groups[key] && typeof groups[key] === 'object' ? groups[key] : {};
  groups[key] = { lastAt: now(), count: (Number(row.count) || 0) + 1, name: row.name || '' };
  await writeJSON('state/groups', groups);
}

/** 连接：地址与令牌来自设置；宿主负责重连与心跳，这里只在 init 之后开一次。 */
async function openSocket() {
  const url = text(cfg.wsUrl, 300).trim() || 'ws://127.0.0.1:3001';
  const token = text(cfg.accessToken, 2048).trim();
  wsState = 'connecting';
  renderStatus();
  try {
    await request('ws.open', token ? { url, token } : { url });
    note(`正在连接 ${url}`);
    // 用户填了 selfId 的话，这里就能确定 @ 判定；没填的话 learnSelf 会去问协议端（问不到会重试）。
    void learnSelf();
  } catch (err) {
    wsState = 'error';
    renderStatus();
    await persistStatus({ lastError: { at: now(), message: `连接失败：${text(err && err.message, 200)}` } });
    note(`连接失败：${text(err && err.message, 160)}`);
  }
}

/** 连接变成 open 之后要问一次"我是谁"（除非用户自己填了）。 */
async function learnSelf() {
  const manual = text(cfg.selfId, 20).replace(/[^0-9]/g, '');
  if (manual) {
    selfId = manual;
    renderStatus();
    return;
  }
  if (selfId || learningSelf) return;
  learningSelf = true;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const id = await fetchLoginInfo();
        if (id) {
          selfId = id;
          renderStatus();
          note(`协议端说机器人是 ${id}`);
          return;
        }
      } catch (err) {
        note(`get_login_info 失败：${text(err && err.message, 120)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    note('没能问到机器人自己的 QQ 号：在设置里填「机器人自己的 QQ 号」即可（@ 判定需要它）');
  } finally {
    learningSelf = false;
  }
}

/** 把问题交给记忆核心，拿回文本。越界/未装/超时都会 reject，由调用方决定怎么讲。 */
async function askCore(msg, body) {
  return request('plugin.call', {
    target: CORE_TARGET,
    method: CORE_METHOD,
    payload: {
      // 三样东西决定用哪一份记忆：会话（roleId）、谁在说（userId）、这一句（text）。
      roleId: msg.roleId,
      userId: msg.userId,
      userName: msg.name,
      text: body,
      platform: 'onebot',
      meta: { groupId: msg.groupId, messageId: msg.messageId },
    },
  });
}

/** 拼出要发回去的消息段：引用 + @ + 正文。顺序就是显示顺序。 */
function replySegments(msg, body) {
  const segments = [];
  if (msg.isGroup && flag('quoteReply', true) && msg.messageId) segments.push(replySegment(msg.messageId));
  if (msg.isGroup && flag('atSender', false)) segments.push(atSegment(msg.userId));
  segments.push(textSegment(text(body, 1200)));
  return segments;
}

async function sendReply(msg, body) {
  const segments = replySegments(msg, body);
  if (msg.isGroup) await sendGroup(msg.groupId, segments);
  else await sendPrivate(msg.userId, segments);
}

/**
 * 处理一条已经判定为"在跟机器人说话"的消息。
 *
 * 修出一个失败时**不静默**：写进 state/status（插件页第一眼能看到），并在用户打开
 * errorToChat 时把原因发到会话里——一个不出声的机器人是最难排查的那种。
 */
async function answer(msg, body) {
  const roleKey = msg.roleId;
  return serialized(roleKey, async () => {
    try {
      const result = await askCore(msg, body);
      const reply = text(result && result.text, 4000).trim();
      if (!reply) throw new Error('记忆核心返回了空回答');
      await sendReply(msg, reply);
      lastReplyAt.set(roleKey, now());
      await persistStatus({ lastError: null });
      await bump('answered');
      note(`答了 ${msg.isGroup ? `群 ${msg.groupId}` : `私聊 ${msg.userId}`}`);
    } catch (err) {
      const reason = text(err && err.message ? err.message : err, 200);
      await persistStatus({ lastError: { at: now(), message: reason } });
      await bump('failed');
      note(`没答上：${reason}`);
      if (flag('errorToChat', false)) {
        await sendReply(msg, `我这边接不上记忆核心：${reason}`).catch(() => {});
      }
      throw err;
    }
  });
}

/** 冷却：同一个会话别连着回答（默认 3 秒）。 */
function cooling(roleKey) {
  const seconds = num('cooldownSec', 0, 600, 3);
  if (seconds <= 0) return false;
  const last = lastReplyAt.get(roleKey) || 0;
  return now() - last < seconds * 1000;
}

/**
 * 一帧入站。返回一段描述（测试与插件页都读它）。
 *
 * 它在**常驻帧**里才有意义：那个文档没有界面，但它是唯一持有连接的那一份。
 */
async function onSocketFrame(raw) {
  const parsed = parseFrame(raw);
  if (parsed.kind === 'invalid') return { kind: 'invalid', reason: parsed.reason };
  if (parsed.kind === 'action-result') {
    return { kind: 'action-result', handled: onActionResult(parsed.frame) };
  }

  const frame = parsed.frame;
  if (frame.post_type === 'meta_event') {
    // 心跳与 lifecycle：只更新状态，不回答（它们不是人说的话）。
    if (frame.meta_event_type === 'lifecycle' && frame.self_id !== undefined) {
      selfId = String(frame.self_id || selfId);
      renderStatus();
    }
    return { kind: 'meta' };
  }
  if (frame.post_type !== 'message') {
    // notice / request：这个接入端不做回应（戳一戳、加好友都交给用户自己在协议端处理）。
    return { kind: 'ignored', reason: `post_type=${frame.post_type}` };
  }

  const msg = messageOf(frame);
  if (!msg) return { kind: 'ignored', reason: '不是可回答的消息' };

  // 重连之后协议端会重发最近的消息：按 message_id 去重，否则用户会看到同一句话被答两遍。
  if (msg.messageId) {
    if (seenIds.has(msg.messageId)) return { kind: 'duplicate' };
    seenIds.add(msg.messageId);
    if (seenIds.size > 200) {
      for (const old of [...seenIds].slice(0, 100)) seenIds.delete(old);
    }
  }

  await touchGroup(msg);

  const decision = addressed(msg, {
    atOnly: flag('atOnly', true),
    prefix: text(cfg.prefix, 40),
    selfId,
    privateReply: flag('privateReply', true),
    groupAllow: splitList(cfg.groupAllow),
  });
  if (!decision.hit) {
    await bump('skipped');
    return { kind: 'skipped', reason: decision.reason };
  }
  if (cooling(msg.roleId)) {
    note('冷却中，跳过');
    return { kind: 'cooling' };
  }

  await answer(msg, decision.body);
  return { kind: 'answered', roleId: msg.roleId };
}

/** "1,2,3" → ['1','2','3']（空值返回 null，表示不限制）。 */
function splitList(raw) {
  const parts = String(raw === undefined || raw === null ? '' : raw)
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}
