// lib/protocol.js —— OneBot v11 的一帧是什么，以及"这句是不是在跟机器人说话"
//
// 只认 v11（NapCat / Lagrange / go-cqhttp 这一族）。所有判断都在这里，因为它们是**这个接入端
// 唯一的知识**：别处不该出现 group_id / message_type 这类平台词汇。
//
// WHY 用消息段数组而不是 raw_message
//
// raw_message 是 CQ 码字符串（`[CQ:at,qq=10000] 你好`）：在里面找 @ 要写正则，而 @ 的写法
// 与转义规则在协议端之间并不完全一致，第一次遇到昵称里带 `[CQ:` 的人就会出错。消息段数组是
// 结构化的，`type` 与 `data` 由协议端解析好了——用它，`@` 就是一次数组查找。

'use strict';

/** 一帧 JSON 文本 → {kind:'event'|'action-result', frame}；坏帧返回 {kind:'invalid'}。 */
function parseFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(String(raw === undefined || raw === null ? '' : raw));
  } catch {
    return { kind: 'invalid', reason: '不是 JSON' };
  }
  if (!frame || typeof frame !== 'object') return { kind: 'invalid', reason: '不是对象' };
  // 动作的回应：带 status/retcode（以及我们发出去时带的 echo）。
  if (typeof frame.retcode === 'number' || typeof frame.status === 'string') {
    return { kind: 'action-result', frame };
  }
  if (typeof frame.post_type === 'string') return { kind: 'event', frame };
  return { kind: 'invalid', reason: '既不是事件也不是动作回应' };
}

/** 消息段数组（老协议端可能只给字符串，那种一键回退到 raw_message）。 */
function segmentsOf(frame) {
  if (Array.isArray(frame && frame.message)) return frame.message.filter((s) => s && typeof s.type === 'string');
  return [];
}

/** 把消息段里的纯文本拼起来。 */
function textOf(frame) {
  const parts = [];
  for (const seg of segmentsOf(frame)) {
    if (seg.type === 'text' && seg.data && typeof seg.data.text === 'string') parts.push(seg.data.text);
  }
  const joined = parts.join('').trim();
  if (joined) return joined;
  // 退路：有的协议端把文本放在 raw_message 里，而 message 只带图片。
  return typeof frame.raw_message === 'string' ? frame.raw_message.trim() : '';
}

/** 这条消息 @ 了谁（QQ 号字符串数组）。 */
function atTargets(frame) {
  const out = [];
  for (const seg of segmentsOf(frame)) {
    if (seg.type === 'at' && seg.data && seg.data.qq !== undefined) out.push(String(seg.data.qq));
  }
  return out;
}

/**
 * 一条消息事件 → 这个插件要的抽象形状，或者 null（不是用户发的消息）。
 *
 * `roleId` 是**记忆的隔离键**：群里一台机器人和私聊里的同一个人是两个会话，而两个群之间更是。
 * 形状写死成 `onebot-group-<群号>` / `onebot-user-<QQ号>`，因为换一个接入端之后旧的记忆还要
 * 认得出自己属于哪儿——它同时也是记忆核心存文件的目录名。
 */
function messageOf(frame) {
  if (!frame || frame.post_type !== 'message') return null;
  const type = frame.message_type;
  if (type !== 'group' && type !== 'private') return null;
  const isGroup = type === 'group';
  const groupId = isGroup ? String(frame.group_id || '') : '';
  const userId = String(frame.user_id || '');
  if (!userId) return null;
  if (isGroup && !groupId) return null;

  const sender = frame.sender && typeof frame.sender === 'object' ? frame.sender : {};
  const name = text(sender.card, 40) || text(sender.nickname, 40) || userId;
  const body = textOf(frame);

  return {
    isGroup,
    groupId,
    userId,
    name,
    text: body,
    messageId: frame.message_id === undefined ? '' : String(frame.message_id),
    // 记忆的隔离键：两个接入端（这个插件与 QQ 插件）用的是不同的前缀，所以它们永远不会
    // 共用一份记忆——除非用户真想那样（那是一个新功能，不是默认行为）。
    roleId: isGroup ? `onebot-group-${groupId}` : `onebot-user-${userId}`,
    segments: segmentsOf(frame),
  };
}

/**
 * 这条消息算不算"在跟机器人说话"。
 *
 * 三条路，都不猜：被 @、用了配置的前缀、或者私聊且允许私聊。`atOnly` 关掉时群里**每条**都算
 * ——那是一个"它自己看着接话"的开关，默认关着，因为一个会插话的机器人很容易变成噪音。
 */
function addressed(msg, options) {
  const { atOnly, prefix, selfId, privateReply, groupAllow } = options;
  if (!msg) return { hit: false, reason: '不是用户消息' };
  if (msg.isGroup && groupAllow && !groupAllow.includes(msg.groupId)) {
    return { hit: false, reason: '群不在白名单里' };
  }
  if (!msg.text) return { hit: false, reason: '没有文字（只有图片/语音）' };

  // 前缀优先：它是用户显式写下来的意图，剥掉前缀之后的正文才是要问的那句。
  const mark = String(prefix || '').trim();
  if (mark && msg.text.startsWith(mark)) {
    const rest = msg.text.slice(mark.length).trim();
    return { hit: rest !== '', reason: '前缀', body: rest || msg.text };
  }

  if (!msg.isGroup) {
    return privateReply ? { hit: true, reason: '私聊', body: msg.text } : { hit: false, reason: '私聊关闭' };
  }
  if (selfId && atTargets({ message: msg.segments }).includes(String(selfId))) {
    return { hit: true, reason: '@', body: msg.text };
  }
  if (!atOnly) return { hit: true, reason: '群内全部', body: msg.text };
  return { hit: false, reason: '没被 @' };
}
