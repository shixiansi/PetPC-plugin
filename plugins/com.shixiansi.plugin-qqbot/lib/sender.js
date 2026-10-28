// lib/sender.js —— 被动回复：net.fetch 调官方 REST 发消息
//
// 官方被动回复的规则（这是本文件存在的原因）：
//   - POST /v2/groups/{group_openid}/messages（群）或 /v2/users/{user_openid}/messages（单聊）
//   - body: { msg_type:0, content, msg_id, msg_seq }
//   - msg_id 是**用户那条消息**的 id，群聊 5 分钟内有效；过期/超次数的回复会被拒
//   - 同一 msg_id + msg_seq 再发会失败，所以对同一条消息的第二次回复 msg_seq 递增
//   - 群聊一条消息最多回 5 次、单聊 4 次——这里守住上限，不做无限重试
//
// 频道（guild）用 /channels/{channel_id}/messages，同样带 msg_id 被动回复。
'use strict';

// 每条收到的消息允许的最大回复次数（比官方上限各少 1 次，给网络重试留余量）。
const REPLY_BUDGET = { group: 4, c2c: 3, guild: 4 };

/** 会话状态里取出"这条 msg_id 已经用到几号 seq"。 */
function nextSeq(state, msgId) {
  const key = String(msgId || '');
  const cur = (state.seq && state.seq[key]) || { n: 0, at: 0 };
  const n = (Number(cur.n) || 0) + 1;
  return { n, at: Date.now() };
}

/**
 * 发一条被动回复。
 * @returns {{ok:boolean, detail:string}} 给日志用的结果；失败不抛错——
 *          消息过期（5 分钟窗口）是常态，不是异常。
 */
async function sendPassiveReply(msg, text, state) {
  const max = num(cfg.replyMaxChars, 300);
  const content = truncate(text, Math.max(1, max));
  if (!content) return { ok: false, detail: '回复内容为空' };

  const seq = nextSeq(state, msg.msgId);
  const budget = REPLY_BUDGET[msg.kind] || 4;
  if (seq.n > budget) {
    return { ok: false, detail: `这条消息已经回过 ${budget} 次（官方上限），不再回复` };
  }

  let path = '';
  const body = { msg_type: 0, content, msg_id: msg.msgId, msg_seq: seq.n };
  if (msg.kind === 'group') {
    path = `/v2/groups/${encodeURIComponent(msg.openid)}/messages`;
  } else if (msg.kind === 'c2c') {
    path = `/v2/users/${encodeURIComponent(msg.openid)}/messages`;
  } else {
    // 频道：路径与字段都不同（content 直接放文本，msg_id 同样用于被动回复）。
    path = `/channels/${encodeURIComponent(msg.openid)}/messages`;
    delete body.msg_seq;
  }

  let res;
  try {
    res = await qqApi('POST', path, body);
  } catch (err) {
    // token 过期是最常见的可恢复失败：换一次 token 立刻重试一次。
    invalidateToken();
    try {
      res = await qqApi('POST', path, body);
    } catch (err2) {
      return { ok: false, detail: `发送失败：${err2.message}` };
    }
  }

  if (res.status >= 200 && res.status < 300) {
    state.seq[msg.msgId] = seq;
    return { ok: true, detail: '' };
  }
  const apiMsg = (res.data && (res.data.message || res.data.msg)) || '';
  const code = (res.data && (res.data.code || res.data.retcode)) || '';
  return { ok: false, detail: `HTTP ${res.status}${code ? ` code ${code}` : ''} ${apiMsg}`.trim() };
}

/** 发一条频道消息（不需要 msg_id 的主动场景暂时没有，保留给 READY 问候之类的扩展）。 */
async function sendChannelMessage(channelId, text) {
  return qqApi('POST', `/channels/${encodeURIComponent(channelId)}/messages`, {
    content: truncate(text, 2000),
  });
}
