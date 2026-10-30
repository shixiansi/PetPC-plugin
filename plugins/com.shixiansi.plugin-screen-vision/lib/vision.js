// lib/vision.js —— analyze_screen：一次"看一眼屏幕"的完整链路
//
//   截图（lib/screenshot.js，经本机辅助脚本）
//     → 上传服务返回 URL（图片必须在 netHosts 白名单里，llm.chat 的 images 才收）
//     → plugin.call 问记忆核心的 chat（问题 + 图片地址）
//     → 记忆核心用它自己的模型配置发 llm.chat（images: [url]），答完把这一轮记进长期记忆
//     → 回答回到这里，写进历史、发布 share 快照
//
// WHY 走 memcore 而不是自己发 llm.chat：视觉不是另一段对话——用户刚在 QQ 里聊过的事
// 应该接得上，回答也该记得住。memcore 的 chat（手册 §6.8 的示例实现）已经把人设、记忆、
// 晋升都做完了，这里只需要把"请看这张图"组织成一条 user 消息。
//
// 工具约定（别的插件这么问）：
//
//   plugin.call { target: "com.shixiansi.plugin-screen-vision", method: "analyze_screen",
//                 payload: { question: "屏幕上这个报错是什么意思" } }
//     → { text, at, meta: { bytes, sha256, tookMs, imageUrl? } }
//
// question 可省略：省略 = "用一两句话概括屏幕上有什么"。

'use strict';

const SHARE_KEY = 'vision/last';
const HISTORY_KEY = 'history/recent';
const HISTORY_CAP = 100;

const MEMCORE_TARGET = 'com.shixiansi.plugin-memcore';
const MEMCORE_METHOD = 'chat';
/** 会话标识：屏幕视觉的往来单独放一份记忆，不混进 QQ 群的会话里。 */
const VISION_ROLE = 'screen-vision';

const DEFAULT_QUESTION = '用一两句话概括屏幕上有什么，重点讲值得注意的内容。';

/** 分析入参清洗：question 可选；cooldown 防连点。 */
function cleanAnalyzePayload(payload) {
  const question = text(payload && payload.question, 2000).trim() || DEFAULT_QUESTION;
  return { question };
}

/** 拿上传服务的地址：配置里填的；空着 = 截图后不解析（只拍不问）。 */
function uploadUrl() {
  return String(cfg.visionBaseUrl || '').trim();
}

/** 图片 URL 在不在白名单里：与 net.fetch 同一条规则（精确匹配 host，带端口算另一条）。 */
function urlHostInWhitelist(url, whitelist) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostWithPort = parsed.host; // host 已含非默认端口
    return whitelist.includes(hostWithPort);
  } catch {
    return false;
  }
}

/** hostWhitelist 语义：上传服务必须把图片回挂到**同一个 host**（llm.chat 的 images 只收
 * 白名单里的 http(s) 地址）。返回可匹配的主机列表：上传端点的 host 打头。 */
function effectiveWhitelist(manifestNetHosts) {
  const configured = String(cfg.visionBaseUrl || '').trim();
  const hosts = [];
  if (configured) {
    try {
      hosts.push(new URL(configured).host);
    } catch {
      // 配置还没填好：不往白名单里塞东西。
    }
  }
  for (const host of manifestNetHosts || []) hosts.push(host);
  return hosts;
}

/**
 * `analyze_screen` 方法本体：也是面板按钮走的同一条路（runAnalysis 在 workshop.js）。
 *
 * @param {object} payload {question?}
 * @returns {Promise<object>} {text, at, meta}
 */
async function handleAnalyzeScreen(payload) {
  const { question } = cleanAnalyzePayload(payload);
  await refreshConfig();

  const cooldown = num('cooldownSec', 0, 600, 10);
  if (cooldown > 0 && lastAnalyzeAt && now() - lastAnalyzeAt < cooldown * 1000) {
    throw new Error(`两次识别之间至少隔 ${cooldown} 秒（刚才那次还在处理；防连点刷屏）`);
  }

  const region = cleanRegion(cfg.region);
  const url = uploadUrl();
  const meta = await captureOnce({ uploadUrl: url, region });

  // 截图完成 → 拿 URL。约定：上传服务把图回挂到与上传端点**同一个 host**（本地服务存图
  // 并按 /shots/… 回拉）。URL 不在白名单（不同 host、非 http(s)）时降级成纯文字提问，
  // 绝不把一个模型拉不到的地址塞进 prompt。
  const upload = await readUploadResult();
  const imageUrl = urlHostInWhitelist(upload && upload.url, effectiveWhitelist([])) ? upload.url : '';

  const answer = imageUrl
    ? await askMemcoreWithImage(question, imageUrl)
    : await askMemcoreTextOnly(question, meta);

  lastAnalyzeAt = now();
  const record = {
    at: lastAnalyzeAt,
    question,
    answer,
    imageUrl,
    bytes: Number(meta.bytes) || 0,
    tookMs: Number(meta.tookMs) || 0,
  };
  void appendHistory(record);

  const snapshot = { ...record, at: lastAnalyzeAt };
  try {
    await request('share.set', { name: 'vision-last', value: JSON.stringify(snapshot) });
  } catch {
    // 牌盘写不进去不影响结果：读这一键的是工坊页，它自己会重读 storage。
  }

  return { text: answer, at: lastAnalyzeAt, meta: { bytes: record.bytes, tookMs: record.tookMs, imageUrl, sha256: String(meta.sha256 || '') } };
}

/** 带图问记忆核心。失败原样抛：宿主的中文错误（未获权限 / 超时）会一路走到 UI。 */
async function askMemcoreWithImage(question, imageUrl) {
  const prompt = [
    '请看这张屏幕截图（就是用户此刻的屏幕）并回答：',
    question,
    `图片地址：${imageUrl}`,
  ].join('\n');
  const out = await request('plugin.call', {
    target: MEMCORE_TARGET,
    method: MEMCORE_METHOD,
    payload: { roleId: VISION_ROLE, userId: 'desktop', userName: '主人', text: prompt, hint: '用户消息里附了一张截图地址，用它看图作答' },
  });
  const reply = out && typeof out.text === 'string' ? out.text : '';
  if (!reply.trim()) throw new Error('记忆核心没有返回内容（检查它的模型配置）');
  return reply;
}

/** 图片没传上去时的降级：凭 meta 让对话继续，绝不静默失败。 */
async function askMemcoreTextOnly(question, meta) {
  const prompt = [
    `（屏幕截图没传上去：${Number(meta.bytes) || 0} 字节，${Number(meta.tookMs) || 0}ms，请据此提醒用户检查「截图上传地址」）`,
    `用户的问题：${question}`,
  ].join('\n');
  const out = await request('plugin.call', {
    target: MEMCORE_TARGET,
    method: MEMCORE_METHOD,
    payload: { roleId: VISION_ROLE, userId: 'desktop', userName: '主人', text: prompt },
  });
  const reply = out && typeof out.text === 'string' ? out.text : '';
  if (!reply.trim()) throw new Error('记忆核心没有返回内容（检查它的模型配置）');
  return reply;
}

/** 记一条历史（插件页的"最近识别"）。记录关闭（maxHistory=0）时不写。 */
async function appendHistory(record) {
  const keep = num('maxHistory', 0, 200, 20);
  if (keep <= 0) return;
  try {
    const list = await readJSON(HISTORY_KEY, []);
    const next = (Array.isArray(list) ? list : [])
      .concat([{ ...record, question: text(record.question, 160), answer: text(record.answer, 4000) }])
      .slice(-keep);
    await writeJSON(HISTORY_KEY, next);
  } catch {
    // 历史是给人看的，写不进去不影响识别本身。
  }
}

async function loadHistory() {
  const list = await readJSON(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}

async function clearHistory() {
  await request('storage.remove', { key: HISTORY_KEY });
}

/** 最近一次分析的间隔控制。跨重启不保留：重启后第一张截图永远放行。 */
let lastAnalyzeAt = 0;
