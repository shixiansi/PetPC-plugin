// lib/convert.js —— Telegram 更新 → 统一消息形状（纯函数，无宿主调用）。
//
// 薄适配器的"薄"就薄在这里：它只认识 Telegram 的报文形状，把每一条更新翻译成
// 「谁、在哪个会话、说了什么文本」，别的什么都不判断。翻译失败（不支持的内容类型、
// 非文本消息）返回 null，调用方跳过它——一条坏消息不能把整轮轮询打断。
//
// 输出形状（发布到 share 键与 on_message 的都是它）：
//   { msgId, chatId, chatTitle, fromId, fromName, text, date, kind }
// 全部是字符串/数字，没有 Telegram 的嵌套对象——读它的人不需要认识 Telegram。
//
// 测试接缝：panel.html 用 <script> 引入即 window.TelegramConvert；测试用
// new Function('window', src) 装载同一份源码（抄 convert-kit 的做法）。

'use strict';

(function () {
  const MAX_TEXT = 3800; // 留出余量：share 值 ≤64 KiB，但单条消息没有理由那么大

  /** 扁平键形状（storage/share 键段用）：压掉不认识的字符。 */
  function keyOf(raw, fallback) {
    const cleaned = String(raw === undefined || raw === null ? '' : raw)
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return cleaned || fallback;
  }

  /** 一条能发的文本的公共部分：去控制字符、截断。 */
  function cleanText(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .trim();
    return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
  }

  function chatTitleOf(chat) {
    if (!chat || typeof chat !== 'object') return '';
    if (typeof chat.title === 'string' && chat.title) return chat.title;
    const name = [chat.first_name, chat.last_name]
      .filter((x) => typeof x === 'string').join(' ').trim();
    if (name) return name;
    if (typeof chat.username === 'string' && chat.username) return `@${chat.username}`;
    return '';
  }

  function fromNameOf(from, chat) {
    if (from && typeof from === 'object') {
      const name = [from.first_name, from.last_name]
        .filter((x) => typeof x === 'string').join(' ').trim();
      if (name) return name;
      if (typeof from.username === 'string' && from.username) return `@${from.username}`;
    }
    return chatTitleOf(chat) || '未知';
  }

  /** 从 message / channel_post / edited_* 里掏出"可用的文本"。 */
  function textOf(m) {
    if (!m || typeof m !== 'object') return '';
    if (typeof m.text === 'string' && m.text.trim()) return cleanText(m.text);
    if (typeof m.caption === 'string' && m.caption.trim()) return cleanText(m.caption);
    return '';
  }

  /**
   * 一条 Telegram update → 统一消息；掏不出文本（贴纸、语音、纯媒体）返回 null。
   * 支持 message / edited_message / channel_post / edited_channel_post（编辑的
   * msgId 不变，读的人靠 msgId 去重）。
   */
  function updateToMessage(update) {
    if (!update || typeof update !== 'object') return null;
    const m = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    if (!m || typeof m !== 'object') return null;
    const text = textOf(m);
    if (!text) return null;
    const chat = m.chat && typeof m.chat === 'object' ? m.chat : {};
    const chatId = chat.id === undefined || chat.id === null ? '' : String(chat.id);
    if (!chatId) return null;
    return {
      msgId: m.message_id === undefined || m.message_id === null ? 0 : Number(m.message_id) || 0,
      chatId,
      chatTitle: chatTitleOf(chat),
      fromId: m.from && m.from.id !== undefined && m.from.id !== null ? String(m.from.id) : '',
      fromName: fromNameOf(m.from, chat),
      text,
      date: Number(m.date) || 0,
      kind: (update.channel_post || update.edited_channel_post) ? 'channel' : 'private-or-group',
    };
  }

  /**
   * 一批 updates（getUpdates 的 result）→ { messages, nextOffset }。
   * Telegram 约定：确认到 N，下次发 offset = N+1。空批次沿用 fallback。
   */
  function batchToMessages(updates, fallbackOffset) {
    const list = Array.isArray(updates) ? updates : [];
    const messages = [];
    let maxId = 0;
    for (const u of list) {
      const msg = updateToMessage(u);
      if (msg) messages.push(msg);
      const uid = Number(u && u.update_id);
      if (Number.isFinite(uid) && uid > maxId) maxId = uid;
    }
    const nextOffset = maxId > 0 ? maxId + 1 : Number(fallbackOffset) || 0;
    return { messages, nextOffset };
  }

  /**
   * sendMessage 的 body。不发 parse_mode：Markdown 解析失败是 400 的头号来源，
   * 薄适配器不猜用户的文本格式——纯文本直发。
   */
  function sendBody(chatId, text) {
    return JSON.stringify({ chat_id: String(chatId), text: cleanText(text) });
  }

  window.TelegramConvert = Object.freeze({
    keyOf,
    cleanText,
    updateToMessage,
    batchToMessages,
    sendBody,
    MAX_TEXT,
  });
})();
