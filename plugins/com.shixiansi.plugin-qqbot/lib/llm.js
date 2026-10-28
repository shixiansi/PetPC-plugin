// lib/llm.js —— 把"一条 QQ 消息"变成"一次 llm.chat"，把回答变回"一条 QQ 回复"
//
// 模型配置的归属（手册 6.6）：端点、模型、密钥、每日上限都是插件自己的 config。
// 留空 = 借用对话插件已配置好的那一套（llm.borrow），密钥不出宿主进程。
//
// 历史的责任也在插件：llm.chat 不会替任何人记转写，所以每个会话（群 OpenID /
// 用户 OpenID）的往来存在自己的 storage 里，每次答复前重新读盘——工坊页可能正在
// 另一个进程里清空它，缓存的副本会悄悄把用户刚删的东西还回来。
'use strict';

const DEFAULT_PERSONA = '你是一只住在用户电脑桌面上的桌宠，同时也是 QQ 机器人。用简短、口语化的中文回答，一两句话就好，不要用 Markdown 标题和列表。';

function personaOf() {
  return String(cfg.persona || '').trim() || DEFAULT_PERSONA;
}

function contextTurnsOf() {
  return Math.min(32, Math.max(0, num(cfg.contextTurns, 8)));
}

/** llm.chat 的 history：[{role:'user'|'assistant', text}]，≤32 条、合计 ≤12000 字符。 */
function clipHistory(history) {
  const out = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const text = truncate(String(h.text || ''), 800);
    total += text.length;
    if (total > 11000) break;
    out.unshift({ role: h.role === 'assistant' ? 'assistant' : 'user', text });
    if (out.length >= 32) break;
  }
  return out;
}

/**
 * 生成一次回复。
 * @param {object} msg normalizeEvent 的产物
 * @returns {Promise<string>} 模型回答（可能为空 = 这次不说话）
 */
async function composeReply(msg) {
  const turns = contextTurnsOf();
  const history = await loadHistory(msg.openid, turns);

  const scene = msg.kind === 'group'
    ? '（来自 QQ 群聊，用户 @ 了你）'
    : msg.kind === 'c2c'
      ? '（来自 QQ 单聊）'
      : '（来自 QQ 频道，用户 @ 了你）';

  const past = clipHistory(history);
  const answer = await request('llm.chat', {
    text: truncate(`${msg.senderName}：${msg.text}`, 3800),
    system: `${personaOf()}\n当前场景${scene}。只输出要发到 QQ 的正文，不要任何前缀、引号或解释。`,
    history: past,
  }).then((res) => String(res && res.text ? res.text : '')).catch((err) => {
    // 宿主的 error 是给人看的中文句子（"插件 X 未获权限 llm.chat"），原样进日志。
    void logEvent('模型错误', err.message);
    return '';
  });

  if (!answer.trim()) return '';

  // 往来写盘（截到 turns 条）；失败不影响这次回复。
  const next = [...history, { role: 'user', text: truncate(msg.text, 500) }, { role: 'assistant', text: truncate(answer, 800) }];
  await saveHistory(msg.openid, next, turns).catch(() => {});
  return answer.trim();
}

/** 模型配置是否可用（工坊页展示用）。 */
async function llmProfile() {
  try {
    return await request('llm.profile', {});
  } catch {
    return { ownReady: false, borrowAllowed: false, ready: false, source: 'none', model: '' };
  }
}
