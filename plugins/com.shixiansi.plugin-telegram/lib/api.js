// lib/api.js —— 把 Telegram Bot API 的两条方法包成两次 net.fetch
//
// 只有两条：getUpdates（收）与 sendMessage（发）。setWebhook、getMe、文件上传都不在这里——
// 一个薄适配器不需要认识 Telegram 的每一件事。
//
// WHY token 只在这个文件里拼、别处一个字都不提：Bot API 的地址形状就是
// `https://api.telegram.org/bot<token>/<method>`，所以 `tgUrl` 是唯一摸 token 的地方，
// 调用方只拿到 `{status, data}`（返回值和错误里都没有 URL）。
//
// WHY 长轮询 25 秒：宿主的 net.fetch 有自己的超时——`app_plugins.go` 里
// `http.Client{Timeout: 30 * time.Second}`（手册 §6.10 没写这一条，去代码里确认的）。25 < 30，
// 每一轮都在宿主的超时之内，所以不需要退回"短轮询 + 15 秒间隔"那种更吵的形状。

'use strict';

const TG_ORIGIN = 'https://api.telegram.org';

/** 服务器替我们等多久（秒）。留 5 秒余量给宿主的 30 秒超时。 */
const LONG_POLL_SECONDS = 25;

/** Telegram 一条消息的上限是 4096 字符；留出余量，别让一次截断把一句话砍成半个字。 */
const TG_MAX_CHARS = 4000;

function tgUrl(method) {
  return `${TG_ORIGIN}/bot${botToken()}/${method}`;
}

/**
 * 发一次请求并解析 JSON 答复。失败**不抛**（除了 net.fetch 自己抛）：401/409/429 都是
 * Telegram 的正常语言，调用方要按 status 分别说清楚；抛出去的只留"连不上"，那是退避的事。
 */
async function tgCall(method, opts) {
  const o = opts || {};
  const url = tgUrl(method) + (o.query ? `?${o.query}` : '');
  const payload = { method: o.body ? 'POST' : 'GET', url };
  if (o.body) {
    payload.body = JSON.stringify(o.body);
    // 只有这四个头允许出现（accept / authorization / content-type / user-agent）。
    payload.headers = { 'content-type': 'application/json' };
  }
  const out = await request('net.fetch', payload);
  const status = Number(out && out.status) || 0;
  const raw = out && typeof out.body === 'string' ? out.body : '';
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  return { status, data, truncated: Boolean(out && out.truncated) };
}

/** 收：offset 是"我要 update_id ≥ offset 的那些"，游标由 lib/poll.js 管。 */
async function tgGetUpdates(offset) {
  const query = `offset=${Number(offset) || 0}&timeout=${LONG_POLL_SECONDS}&limit=${pollBatch()}`;
  return tgCall('getUpdates', { query });
}

/** 发：一条纯文本。失败由调用方记账，这里不重试（重发会变成对同一个人的两次回答）。 */
async function tgSendMessage(chatId, line) {
  const body = { chat_id: String(chatId), text: text(line, TG_MAX_CHARS) };
  return tgCall('sendMessage', { body });
}

/**
 * 429 的 `parameters.retry_after`（秒）。Telegram 把它放在 `parameters` 里，也在 `description`
 * 里写一遍（"Too Many Requests: retry after 12"）。先读字段，读不到再从那句话里抠。
 */
function tgRetryAfter(data) {
  const params = (data && data.parameters) || {};
  const fromField = Number(params.retry_after);
  if (Number.isFinite(fromField) && fromField > 0) return Math.min(3600, Math.ceil(fromField));
  const m = /retry after (\d+)/i.exec(String((data && data.description) || ''));
  if (m) return Math.min(3600, Math.max(1, Number(m[1])));
  return 0;
}
