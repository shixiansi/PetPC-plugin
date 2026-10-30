// lib/inbound.js —— 事件解析、去重、触发判定
//
// 网关递过来的 Dispatch 事件在这里变成"要不要让模型说一句话"的决定。
// 三类事件认识，其它记录下来（用户可以关掉记录）：
//
//   GROUP_AT_MESSAGE_CREATE   群里有人 @ 机器人
//   C2C_MESSAGE_CREATE        用户单聊发消息给机器人
//   AT_MESSAGE_CREATE         频道公域 @ 机器人（intents 预设含 guild 时才有）
//   GROUP_ADD_ROBOT / GROUP_DEL_ROBOT / FRIEND_ADD / FRIEND_DEL 群与好友的进出
//
// 去重是硬需求：官方文档明说"相同 msg_id 可能多次推送"。这里用一个内存内的
// 最近事件 id 表（环形覆盖），磁盘不需要持久——重连补发的事件最多这几秒内的。
'use strict';

const DEDUPE_MAX = 256;
const recentIds = new Set();
const recentIdOrder = [];

function seenBefore(eventId) {
  const id = String(eventId || '');
  if (!id) return false;
  if (recentIds.has(id)) return true;
  recentIds.add(id);
  recentIdOrder.push(id);
  while (recentIdOrder.length > DEDUPE_MAX) {
    recentIds.delete(recentIdOrder.shift());
  }
  return false;
}

// --- 事件归一化 --------------------------------------------------------------

/**
 * 把一行官方事件变成统一的"会话消息"：
 *   { kind:'group'|'c2c'|'guild', openid, msgId, eventId, text, senderId, senderName, at, raw }
 * 返回 null 表示这条不需要处理（重复、不认识、或者只是状态事件）。
 */
function normalizeEvent(type, d, frame) {
  const eventId = String((frame && frame.id) || '');
  switch (type) {
    case 'GROUP_AT_MESSAGE_CREATE': {
      if (seenBefore(eventId || d.id)) return null;
      return {
        kind: 'group',
        openid: String(d.group_openid || ''),
        msgId: String(d.id || ''),
        eventId,
        text: flatten(d.content),
        senderId: String((d.author && d.author.id) || d.author.member_openid || ''),
        senderName: String((d.author && (d.author.username || d.author.nickname)) || '群成员'),
        at: parseTimestamp(d.timestamp) || Date.now(),
        raw: d,
      };
    }
    case 'C2C_MESSAGE_CREATE': {
      if (seenBefore(eventId || d.id)) return null;
      return {
        kind: 'c2c',
        openid: String((d.author && d.author.user_openid) || d.user_openid || ''),
        msgId: String(d.id || ''),
        eventId,
        text: flatten(d.content),
        senderId: String((d.author && d.author.user_openid) || ''),
        senderName: String((d.author && (d.author.username || d.author.nickname)) || '好友'),
        at: parseTimestamp(d.timestamp) || Date.now(),
        raw: d,
      };
    }
    case 'AT_MESSAGE_CREATE': { // 频道公域
      if (seenBefore(eventId || d.id)) return null;
      return {
        kind: 'guild',
        openid: String(d.channel_id || ''),
        msgId: String(d.id || ''),
        eventId,
        text: flatten(d.content),
        senderId: String((d.author && d.author.id) || ''),
        senderName: String((d.author && d.author.username) || '频道用户'),
        at: parseTimestamp(d.timestamp) || Date.now(),
        raw: d,
      };
    }
    case 'GROUP_ADD_ROBOT':
      void logEvent('进群', `${d.op_member_openid || '有人'} 把机器人加进了群（openid ${truncate(String(d.group_openid || ''), 16)}）`);
      return null;
    case 'GROUP_DEL_ROBOT':
      void logEvent('退群', `机器人被移出群（openid ${truncate(String(d.group_openid || ''), 16)}）`);
      // 顺手清掉这个群的记忆：不在群里了，留着也是误导下一次加入的自己。
      // 两个键都在（往来在 `s/`、节流状态在同级的 `m/`），少删一个就是留下半个会话。
      void storageRemove(flatKey(d.group_openid));
      void storageRemove(metaKey(d.group_openid));
      return null;
    case 'FRIEND_ADD':
      void logEvent('新好友', `用户 ${d.user_openid || ''} 添加了机器人`);
      return null;
    case 'FRIEND_DEL':
      void logEvent('好友移除', `用户 ${d.user_openid || ''} 删除了机器人`);
      return null;
    default:
      if (String(cfg.echoUnknownEvents) === 'true' && type) {
        note(`事件 ${type}（未处理）`);
      }
      return null;
  }
}

async function storageRemove(key) {
  await request('storage.remove', { key }).catch(() => {});
}

// --- 触发判定 ----------------------------------------------------------------

/** 群 OpenID 白名单：留空=所有群；否则逗号分隔精确匹配。 */
function groupAllowed(openid) {
  const allow = String(cfg.groupAllow || '').trim();
  if (!allow) return true;
  return allow.split(/[,\s，、]+/).map((s) => s.trim()).filter(Boolean).includes(openid);
}

/**
 * 这条消息要不要回。群聊只回 @（官方事件本身就是 @ 才推送，所以到这里的群消息
 * 天然满足）；单聊每条都回。返回 null = 不回；否则返回一个待答复对象。
 */
function shouldReply(msg) {
  if (!msg || !msg.openid || !msg.text) return null;
  if (msg.kind === 'group' && !groupAllowed(msg.openid)) {
    note(`群 ${truncate(msg.openid, 12)} 不在白名单里，忽略`);
    return null;
  }
  if (msg.kind === 'c2c') {
    // 消息类型 3=结构化卡片 102=聊天记录 103=引用消息：文本拿不全，别硬答。
    const mtype = Number(msg.raw && msg.raw.message_type);
    if (Number.isFinite(mtype) && mtype !== 0 && mtype !== 101) {
      void logEvent('跳过', `单聊消息类型 ${mtype} 暂不支持回答`);
      return null;
    }
  }
  return msg;
}

// --- 频控 --------------------------------------------------------------------

/** 同一会话的冷却；被动回复窗口由 sender.js 负责，这里只挡"刷屏式"连回。 */
function withinCooldown(state, cooldownSec) {
  if (cooldownSec <= 0) return false;
  return Date.now() - (state.lastReplyAt || 0) < cooldownSec * 1000;
}

// --- 分发入口 ----------------------------------------------------------------

const inboundHandlers = { onMessage: () => {} };

function setInboundHandler(handler) {
  inboundHandlers.onMessage = handler || (() => {});
}

function handleEventType(type, d, frame) {
  const msg = normalizeEvent(type, d, frame);
  if (msg) {
    try {
      inboundHandlers.onMessage(msg);
    } catch (err) {
      note(`处理消息出错：${err.message}`);
    }
  }
}
