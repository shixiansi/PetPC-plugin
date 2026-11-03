// lib/pipeline.js —— 一条 update 进来，一句话出去
//
//   update ──▶ 游标（防重复） ──▶ 是不是 message.text ──▶ 白名单 ──▶ plugin.call(memcore chat)
//                                                                          │
//                        Telegram ◀── sendMessage ────────────────────────┘
//
// 这条链上每一段都能"没反应"，所以每一段都必须留下一条说得清的理由（note + plugin.log）：
// 一个安静的 bot 和"没装"在用户眼里没有区别。

'use strict';

/** 记忆核心的 id 与方法名，和 manifest 的 `callTargets` 是同一个字符串的两份——改一处就要改两处。 */
const MEMCORE_TARGET = 'com.shixiansi.plugin-memcore';

/**
 * 记忆核心答不上来时发给对方的那句话。
 *
 * WHY 不是原始错误：宿主拒绝的原因（没授权、每日额度、模型配置坏了）是**这台机器内部的信息**，
 * 收消息的人不该看到它；那段文本还可能带着模型名、目录名甚至 token。细节进日志，人话进聊天。
 */
const MEMCORE_FAIL = '我这边出错了，稍后再试';

/** 一条进来的文本最多交给记忆核心多少字（plugin.call 的 payload 上限是 64 KiB）。 */
const MAX_INBOUND_CHARS = 4000;

function displayName(from) {
  if (!from || typeof from !== 'object') return '';
  const name = [from.first_name, from.last_name].filter((s) => typeof s === 'string' && s).join(' ').trim();
  return text(name || from.username || '', 40);
}

/**
 * 这条 update 是什么。`getUpdates` 会把 my_chat_member / channel_post / callback_query 一起
 * 送过来，而只有 `message` 里才有"谁在哪个会话里说了一句话"。
 */
function updateKind(update) {
  const keys = Object.keys(update).filter((k) => k !== 'update_id');
  if (keys.includes('message')) return 'message';
  return keys.length ? keys[0] : 'unknown';
}

/** `message` 里不是 text 的那些字段名：日志要能说清"跳过的是哪种"，否则永远是"没反应"。 */
function nonTextKind(message) {
  const known = [
    'sticker', 'voice', 'audio', 'photo', 'video', 'video_note', 'animation', 'document',
    'location', 'venue', 'contact', 'poll', 'dice', 'story', 'pinned_message',
    'new_chat_members', 'left_chat_member',
  ];
  for (const key of known) {
    if (message[key] !== undefined) return key;
  }
  return 'attachment';
}

/**
 * 问记忆核心一句话。形状来自 memcore 的 `chat`（payload `{roleId, userId, userName?, text,
 * platform?}`，返回 `{text, meta}`）：`roleId` 决定用哪一份记忆，所以一个会话就是一个 roleId。
 */
async function askMemcore(payload) {
  try {
    const out = await request('plugin.call', {
      target: MEMCORE_TARGET,
      method: 'chat',
      payload,
    });
    const reply = out && typeof out.text === 'string' ? out.text.trim() : '';
    if (!reply) return { ok: false, error: '记忆核心没有给出回答（返回里没有 text）' };
    return { ok: true, text: reply, meta: (out && out.meta) || null };
  } catch (err) {
    return { ok: false, error: text(redact(err && err.message ? err.message : err), 200) };
  }
}

/** 发一条出去；失败只记账，不重试（重发就是对同一个人的第二次回答）。 */
async function deliver(chatId, line) {
  try {
    const res = await tgSendMessage(chatId, line);
    if (res.status === 200 && res.data && res.data.ok === true) {
      return { ok: true, messageId: (res.data.result && res.data.result.message_id) || null };
    }
    note(`发不出去（HTTP ${res.status || '?'}）`);
    logLine('warn', `sendMessage 失败：HTTP ${res.status || '?'} ${text(res.data && res.data.description, 80)}`);
    return { ok: false };
  } catch (err) {
    note('发不出去（请求本身失败了，原因见宿主日志）');
    logLine('warn', `sendMessage 请求失败：${text(redact(err && err.message ? err.message : err), 160)}`);
    return { ok: false };
  }
}

/**
 * 处理一条 update。返回 `{ignored, ok, reason}`——轮询循环不看它，测试与日志看。
 */
async function ingestUpdate(update) {
  if (!update || typeof update !== 'object') return { ignored: true, reason: '不是对象' };

  const id = Number(update.update_id);
  if (Number.isFinite(id)) {
    // 游标是"下一条我要的 update_id"。比它小 = 已经处理过：Telegram 会重发（上一轮没确认成功），
    // 宿主的 storage 也能让游标活过重启。少了这一步，同一条消息会被回答两次。
    if (id < cursor) {
      pollState.skipped += 1;
      return { ignored: true, reason: '处理过了' };
    }
    await advanceCursor(id + 1);
  }

  const kind = updateKind(update);
  if (kind !== 'message') {
    pollState.skipped += 1;
    note(`忽略 update：${kind}（这个插件只读 message.text）`);
    logLine('info', `忽略 update：${kind}（只处理 message.text）`);
    return { ignored: true, reason: kind };
  }

  const message = update.message;
  const chat = (message && message.chat) || {};
  const chatId = chat.id === undefined || chat.id === null ? '' : String(chat.id);
  const from = (message && message.from) || {};

  if (typeof message.text !== 'string' || !message.text.trim()) {
    const what = nonTextKind(message);
    pollState.skipped += 1;
    note(`忽略一条 ${what}（只处理文本消息）`);
    logLine('info', `忽略一条 ${what}：没有 message.text（贴图/语音/频道消息都在这一类）`);
    return { ignored: true, reason: what };
  }
  if (from.is_bot === true) {
    pollState.skipped += 1;
    note('忽略一个机器人发来的消息（不和同行对吵）');
    return { ignored: true, reason: 'bot' };
  }
  if (!chatId) {
    pollState.skipped += 1;
    note('忽略一条没有 chat.id 的消息（不知道回给谁）');
    return { ignored: true, reason: 'no-chat' };
  }
  // 白名单是**唯一**的准入：留空就是谁的都不收。所以名单为空时仍然把 chat id 记下来——
  // 用户第一次配 bot 时根本不知道自己的 id，那一行日志就是他找到它的方式。
  if (!chatAllowed(chatId)) {
    pollState.skipped += 1;
    note(`收到 chat ${chatId} 的消息，但不在允许名单里（把它填进设置就能收）`);
    logLine('info', `不在允许名单里：chat ${chatId}（设置里的「允许的 chat id」留空=谁的都不收）`);
    return { ignored: true, reason: 'not-allowed' };
  }

  const line = text(message.text.trim(), MAX_INBOUND_CHARS);
  const answer = await askMemcore({
    roleId: `telegram:${chatId}`,
    // 没有 from.id（频道、匿名管理员）时退回 chat id：记忆核心那边至少要有个"谁"的键。
    userId: from.id === undefined ? chatId : String(from.id),
    userName: displayName(from),
    text: line,
    platform: 'telegram',
  });

  if (!answer.ok) {
    pollState.failed += 1;
    pollState.lastError = text(answer.error, 200);
    // 原文只进日志；对方看到的永远是那一句人话。
    logLine('warn', `记忆核心没答上来：${answer.error}`);
    note('记忆核心没答上来，已回一句「我这边出错了」');
    await deliver(chatId, MEMCORE_FAIL);
    return { ignored: false, ok: false, reason: 'memcore' };
  }

  const sent = await deliver(chatId, answer.text);
  if (sent.ok) {
    pollState.answered += 1;
    note(`回答了 chat ${chatId} 的一句（${answer.text.length} 字）`);
  } else {
    pollState.failed += 1;
  }
  return { ignored: false, ok: sent.ok };
}

/**
 * `serves: ["on_message"]` —— 别的插件用 `plugin.call` 把一句话交给这个管道。为什么要有它：
 * 另一个插件（语音入口、用户自己的脚本）不必知道 Telegram 的 API 形状，也能让 bot 说出话。
 * `send:false` 时只回答、不发出去。
 */
async function handleOnMessage(payload) {
  const body = payload || {};
  const line = text(typeof body.text === 'string' ? body.text.trim() : '', MAX_INBOUND_CHARS);
  if (!line) throw new Error('on_message 需要 text：要交给记忆核心的那句话');
  const chatId = text(body.chatId, 40).trim();
  const roleId = text(body.roleId, 80).trim() || (chatId ? `telegram:${chatId}` : 'telegram:plugin-call');

  const answer = await askMemcore({
    roleId,
    userId: text(body.userId, 40),
    userName: text(body.userName, 40),
    text: line,
    platform: 'telegram',
  });
  if (!answer.ok) {
    logLine('warn', `on_message 的回答失败：${answer.error}`);
    throw new Error('记忆核心没有回答上来（细节在插件日志里）');
  }

  let sent = false;
  let messageId = null;
  if (chatId && body.send !== false) {
    if (!chatAllowed(chatId)) throw new Error(`chat ${chatId} 不在允许的 chat id 名单里`);
    const out = await deliver(chatId, answer.text);
    sent = out.ok;
    messageId = out.messageId || null;
  }
  return { reply: answer.text, sent, messageId, roleId };
}
