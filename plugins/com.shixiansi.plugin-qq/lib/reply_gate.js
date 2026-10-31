// lib/reply_gate.js —— 回复门控打分器（纯规则，零 LLM）
//
// 从 MaiBot 的 src/maisaka/turn_trigger/reply_likelihood.py 直译（权重逐字一致，
// 由该项目的 scripts/explore_reply_necessity.py 用门控期间 Planner 首轮记录拟合），
// 阈值表取自同目录 dynamic_gate.py 的离线统计。
//
//   logit = -1.2005
//         + 1.5852 × mention_bot          新消息提到 / @ 了机器人
//         - 1.1157 × at_other             @ 了别人（话题不是对它说的）
//         + 0.4807 × has_question_mark    带问号
//         - 1.0281 × placeholder_only     整条只是表情/图片占位
//         + 2.6525 × recent_self_ratio    最近窗口里机器人自己的发言占比（它活跃的群它更活跃）
//         - 0.0367 × recent_message_count 刷屏抑制
//         + 0.0571 × log1p(seconds_since_bot_message)  冷场越久越值得说一句
//         + 0.1012 × pending_count        本批积压消息条数
//   p = 1 / (1 + e^-logit)
//
// 为什么替换掷硬币：`replyChance` 对同一句话昨天回、今天不回，行为不可解释；
// 这里每个特征都可解释、可在日志里复盘（takeTurn 的静默日志会带概率与阈值）。
//
// 纯函数、无任何宿主依赖：tests/plugin-qq.test.js 直接加载本文件做单元断言。
'use strict';

/** 待处理消息数进入函数前的上限，与 MaiBot 拟合时的截断一致。 */
const GATE_MAX_PENDING_COUNT = 20;
/** 上下文中没有机器人发言时采用的间隔（秒），与拟合时的缺省值一致。 */
const GATE_DEFAULT_SECONDS_SINCE_BOT = 3600;

/** 只有媒体占位、没有文字内容的消息前缀（QQ 插件 plainText 的占位约定）。 */
const GATE_MEDIA_PREFIXES = [
  '[表情包', '[图片', '[消息类型]', '[CQ:image', '[语音', '[文件]', '[卡片',
  '[表情', '[视频', '[动画表情', '[语音（听不到）', '[视频（画面看不到）',
];

// 拟合权重：logit = 截距 + Σ 权重 × 特征（MaiBot 源码逐字）。
const GATE_W = {
  INTERCEPT: -1.2005,
  MENTION_BOT: 1.5852,
  AT_OTHER: -1.1157,
  QUESTION: 0.4807,
  PLACEHOLDER_ONLY: -1.0281,
  RECENT_SELF_RATIO: 2.6525,
  RECENT_MESSAGE_COUNT: -0.0367,
  LOG_SECONDS_SINCE_BOT: 0.0571,
  PENDING_COUNT: 0.1012,
};

/**
 * MaiBot dynamic_gate 的离线阈值表：保留多少比例的主动回复 → 概率阈值。
 * 设置项「插话频率」的三档即取表中三行（保留 10% / 30% / 50%）。
 */
const GATE_KEEP_RATIO_THRESHOLDS = [
  { keepRatio: 0.1, threshold: 0.605 },
  { keepRatio: 0.3, threshold: 0.43 },
  { keepRatio: 0.5, threshold: 0.336 },
];

/**
 * 从一批新消息文本得到 (at_other, hasQuestionMark, placeholderOnly)。
 * 与 MaiBot summarize_pending_texts 语义一致；`texts` 是 plainText() 展开后的行。
 */
function summarizePendingTexts(texts, hasAtBot) {
  const stripped = (texts || []).map((t) => String(t || '').trim()).filter(Boolean);
  const atOther = !hasAtBot && stripped.some((t) => t.includes('@'));
  const hasQuestionMark = stripped.some((t) => t.includes('?') || t.includes('？'));
  const placeholderOnly = stripped.length > 0 && stripped.every((t) => GATE_MEDIA_PREFIXES.some((p) => t.startsWith(p)));
  return { atOther, hasQuestionMark, placeholderOnly };
}

/**
 * 估计这批消息值得接话的概率（0–1）。
 *
 * @param {object} input 对话快照：
 *   mentionBot 是否提到 / @ 机器人；atOther 是否 @ 了别人；hasQuestionMark 是否带问号；
 *   placeholderOnly 是否全是媒体占位；recentSelfRatio 最近窗口里机器人发言占比（0–1）；
 *   recentMessageCount 最近窗口的消息条数；secondsSinceBotMessage 距机器人上次发言的秒数；
 *   pendingCount 本批新消息条数。
 */
function estimateReplyProbability(input) {
  const snap = input || {};
  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const logit = GATE_W.INTERCEPT
    + GATE_W.MENTION_BOT * (snap.mentionBot ? 1 : 0)
    + GATE_W.AT_OTHER * (snap.atOther ? 1 : 0)
    + GATE_W.QUESTION * (snap.hasQuestionMark ? 1 : 0)
    + GATE_W.PLACEHOLDER_ONLY * (snap.placeholderOnly ? 1 : 0)
    + GATE_W.RECENT_SELF_RATIO * clamp01(snap.recentSelfRatio)
    + GATE_W.RECENT_MESSAGE_COUNT * Math.max(0, Number(snap.recentMessageCount) || 0)
    + GATE_W.LOG_SECONDS_SINCE_BOT * Math.log1p(Math.max(0, Number(snap.secondsSinceBotMessage) || 0))
    + GATE_W.PENDING_COUNT * Math.min(GATE_MAX_PENDING_COUNT, Math.max(0, Number(snap.pendingCount) || 0));
  return 1 / (1 + Math.exp(-logit));
}

/**
 * 「插话频率」设置 → 概率阈值。
 *
 * quiet=安静（保留 10%）、natural=自然（30%，默认）、active=活跃（50%）；
 * 也接受 0-100 的 keep-ratio 数字（replyChance 的语义：30 ≈ 十次机会接三次，
 * 换算成保留比例 keepRatio = chance/100，取表中最接近的一档）；
 * 其它未知值回落到 natural——老配置升级后不会突然变得话痨或失语。
 */
function gateThresholdFor(chattyLevel) {
  const key = String(chattyLevel === undefined || chattyLevel === null ? '' : chattyLevel).trim().toLowerCase();
  if (key === 'quiet') return 0.605;
  if (key === 'natural') return 0.43;
  if (key === 'active') return 0.336;
  const numeric = Number(key);
  if (Number.isFinite(numeric) && numeric > 0 && numeric < 100) {
    const keepRatio = numeric / 100;
    // 取 keepRatio 与表项差值最小的一档（10% → 0.605、30% → 0.43、50% → 0.336）。
    let best = GATE_KEEP_RATIO_THRESHOLDS[0];
    for (const row of GATE_KEEP_RATIO_THRESHOLDS) {
      if (Math.abs(row.keepRatio - keepRatio) < Math.abs(best.keepRatio - keepRatio)) best = row;
    }
    return best.threshold;
  }
  return 0.43;
}

/**
 * 门控判定：trigger（接）/ wait（沉默）。
 *
 * `forced`（被 @、带前缀）直接放行——那是用户在跟它说话，不进打分；
 * 这也是 MaiBot gates.py 的语义（被 @ 的消息由强制触发直接放行）。
 *
 * @returns {{decision: 'trigger'|'wait', probability: number, threshold: number}}
 */
function gateDecision(input, threshold, forced) {
  const probability = estimateReplyProbability(input);
  const limit = Number.isFinite(threshold) ? threshold : 0.43;
  if (forced) return { decision: 'trigger', probability, threshold: limit };
  return { decision: probability >= limit ? 'trigger' : 'wait', probability, threshold: limit };
}

// --- 最近窗口统计（estimateReplyProbability 的三个窗口特征的来源） -------------------
//
// MaiBot 的对应物是它的消息仓库 5 分钟窗口；这里没有仓库可查，就自己记一个
// 每群的滑动窗口（60 秒足够 QQ 群节奏，也便宜）。窗口只存"有没有"，不存文本，
// 所以不会把聊天内容复制一份进内存。

const GATE_WINDOW_MS = 60_000;
/** 每群最多记多少条窗口消息：防爆内存的上限，正常群 1 分钟到不了这个量。 */
const GATE_WINDOW_CAP = 120;

/**
 * 记一条消息进某个群的门控窗口。
 *
 * @param {string|number} groupID
 * @param {string} speaker 发言人昵称（只用等值比较认"是不是机器人自己"）
 * @param {string} text 消息文本（只用来判断是不是机器人自己的发言）
 * @param {boolean} selfMessage 这条是否机器人自己的发言（bili.js 调 reply 路径时传 true）
 */
function noteGateWindow(groupID, speaker, text, selfMessage) {
  const key = String(groupID);
  const now = Date.now();
  let window = state.gateWindows.get(key);
  if (!window) {
    window = { self: [], entries: [] };
    state.gateWindows.set(key, window);
  }
  window.entries.push({ at: now, speaker: String(speaker || '') });
  if (selfMessage) window.self.push(now);
  // 双端裁剪：条数上限 + 60 秒以外的旧条目。
  const cutoff = now - GATE_WINDOW_MS;
  while (window.entries.length > GATE_WINDOW_CAP) window.entries.shift();
  while (window.self.length && window.self[0] < cutoff) window.self.shift();
}

/** 记一条"机器人自己发了言"进窗口（takeTurn 发送成功后调用）。 */
function noteGateSelf(groupID) {
  const key = String(groupID);
  const window = state.gateWindows.get(key);
  const now = Date.now();
  if (window) {
    window.self.push(now);
    window.entries.push({ at: now, speaker: '__self__' });
  }
}

/**
 * 读窗口统计 + 从当前文本取即时特征，拼成 gateDecision 的输入。
 *
 * secondsSinceBotMessage：窗口里没有机器人发言时用 GATE_DEFAULT_SECONDS_SINCE_BOT
 * （= MaiBot 拟合时的缺省 3600，即"冷场很久"）。
 */
function gateWindowStats(currentText) {
  let recentSelfRatio = 0;
  let recentMessageCount = 0;
  let secondsSinceBotMessage = GATE_DEFAULT_SECONDS_SINCE_BOT;
  const window = state.gateWindows.get(state.gateCurrentGroup || '');
  if (window) {
    const now = Date.now();
    const cutoff = now - GATE_WINDOW_MS;
    const recent = window.entries.filter((entry) => entry.at >= cutoff);
    recentMessageCount = recent.length;
    const selfRecent = window.self.filter((at) => at >= cutoff);
    recentSelfRatio = recent.length ? selfRecent.length / recent.length : 0;
    if (selfRecent.length) secondsSinceBotMessage = Math.max(0, (now - selfRecent[selfRecent.length - 1]) / 1000);
  }
  return {
    recentSelfRatio,
    recentMessageCount,
    secondsSinceBotMessage,
    ...summarizePendingTexts([currentText], false),
  };
}
