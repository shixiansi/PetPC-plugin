// lib/reply_splitter.js —— 后处理拆分器：一段回复 → [消息列表]（+ 每条建议延迟）
//
// 从 MaiBot 的 src/chat/utils/utils.py（process_llm_response_segments /
// _split_into_sentence_segments / calculate_typing_time）抽离的纯规则版，通宵任务
// 里已在 Python 侧用 15 个用例验证过语义（~/chat-delta-lab/extracted/reply_splitter），
// 本文件是它的 JS 直译。
//
// 为什么需要它：pet 现在把整段回复一次性发出去，一段 200 字的"客服腔长文"在群里
// 是一坨；MaiBot 的做法是按标点拆成几条、逐条带"打字时间"发出去，读起来像人。
//
// 约定（与实验一致）：
//   · maxSplitNum 条上限：超过就均匀合并回去，不丢内容；
//   · 引号内不切（8 种引号），分割点两侧都是英文字母不切（URL/单词不腰斩）；
//   · 打字延迟：中文 0.3s/字、英文 0.15s/字、单个汉字 ×3、emoji/图固定 1s，
//     打完后加 0.3s"回车时间"（MaiBot calculate_typing_time 的语义）。
//
// 纯函数、无宿主依赖：tests/plugin-qq.test.js 直接加载本文件做单元断言。
'use strict';

/** 一次回复最多拆成几条消息（MaiBot ResponseSplitterConfig.max_split_num 默认值）。 */
const SPLIT_MAX_COUNT = 3;
/** 单条长度软上限：超过它才值得拆。 */
const SPLIT_MIN_LENGTH = 60;
/** 打字速度倍率（对应 MaiBot response_post_process.typing_speed=1）。 */
const TYPING_SPEED = 1.0;

const SPLIT_SEPARATORS = '，。；？！、;?!';
const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』', '《': '》', '（': '）', '(': ')' };
const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/g;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

/** 切分点识别：分隔符位置，引号内不切、两侧都是英文字母不切。 */
function splitPoints(text) {
  const points = [];
  const closingOf = {};
  const quoteStack = [];
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    if (Object.prototype.hasOwnProperty.call(QUOTE_PAIRS, ch)) {
      const closing = QUOTE_PAIRS[ch];
      closingOf[closing] = closingOf[closing] || ch;
      // 英文引号开闭同形：栈顶同类视为关闭；否则若与栈顶成对则闭合，否则入栈。
      if ((ch === '"' || ch === "'") && quoteStack.length && quoteStack[quoteStack.length - 1] === ch) {
        quoteStack.pop();
      } else if (closing !== ch && quoteStack.length && quoteStack[quoteStack.length - 1] === closing) {
        quoteStack.pop();
      } else {
        quoteStack.push(ch);
      }
      continue;
    }
    const isSeparator = SPLIT_SEPARATORS.includes(ch) || /\s/.test(ch);
    if (!isSeparator) continue;
    if (quoteStack.length) continue;
    const prevCh = index > 0 ? chars[index - 1] : '';
    const nextCh = index + 1 < chars.length ? chars[index + 1] : '';
    // 两侧都是英文字母/数字：不切（https://a.b、example.com 这类不腰斩）。
    if (/[A-Za-z0-9]/.test(prevCh) && /[A-Za-z0-9]/.test(nextCh)) continue;
    points.push(index);
  }
  return points;
}

/** 按切分点切段、去掉空段（分隔符本身不保留——拆条就是要句号消失）。 */
function splitSentences(text) {
  const cleaned = String(text || '').replace(ZERO_WIDTH_RE, '').trim();
  if (!cleaned) return [];
  const points = splitPoints(cleaned);
  if (!points.length) return [cleaned];
  const segments = [];
  let start = 0;
  for (const point of points) {
    const segment = cleaned.slice(start, point).trim();
    if (segment) segments.push(segment);
    start = point + 1;
  }
  const tail = cleaned.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

/**
 * 超过 maxCount 段时均匀合并回去（_merge_processed_segments_to_max_count 的分组语义）。
 * 合并用顿号类分隔的"，"接回，比硬拼接可读。
 */
function mergeToMaxCount(sentences, maxCount) {
  if (maxCount <= 0 || sentences.length <= maxCount) return sentences;
  const total = sentences.length;
  const starts = [];
  let startIndex = 0;
  for (let group = 0; group < maxCount; group += 1) {
    const remainingSegments = total - startIndex;
    const remainingGroups = maxCount - group;
    const groupSize = Math.ceil(remainingSegments / remainingGroups);
    starts.push(startIndex);
    startIndex += groupSize;
  }
  const merged = [];
  for (let position = 0; position < starts.length; position += 1) {
    const end = position + 1 < starts.length ? starts[position + 1] : total;
    const group = sentences.slice(starts[position], end);
    merged.push(group.map((part) => part.replace(/^，+|，+$/g, '')).filter(Boolean).join('，'));
  }
  return merged.filter(Boolean);
}

/** calculate_typing_time 的直译：这条消息"打出来"要几秒。 */
function calculateTypingDelay(message) {
  const body = String(message || '');
  if (!body) return 0;
  // emoji-only 判定按**码点**数（Array.from），不是 .length——JS 的 length 是码元数，
  // 一个非 BMP emoji（😂）length=2，按码元数判定永远不会相等。
  const matches = body.match(new RegExp(EMOJI_RE.source, 'gu')) || [];
  const emojiOnly = matches.length > 0 && Array.from(body).length === matches.length;
  if (emojiOnly) return 1.0;
  const chineseChars = (body.match(/[\u4e00-\u9fff]/g) || []).length;
  if (chineseChars === 1 && body.trim().length === 1) return 0.3 * 3 + 0.3;
  let total = 0;
  for (const ch of body) {
    total += /[\u4e00-\u9fff]/.test(ch) ? 0.3 : 0.15;
  }
  return total * TYPING_SPEED + 0.3;
}

/**
 * 主入口：发进群前的一段回复 → 要逐条发送的消息列表。
 *
 * 语义：
 *   · 短于 SPLIT_MIN_LENGTH、或切不出多段 → 原样一条（绝大多数回复走这条，零行为变化）；
 *   · 切出的段数 ≤ SPLIT_MAX_COUNT → 按段拆；
 *   · 段数超了 → 均匀合并回 SPLIT_MAX_COUNT 条，不丢内容；
 *   · 拆出来的"段"仍然太长（> maxChars）→ 放弃拆分返回原文（tidyReply 已经截过，不会更糟）。
 *
 * @param {string} text 已经过 tidyReply 的最终回复
 * @param {number} [maxChars] 单条上限（caller 传 replyMaxChars；拆分尊重它）
 * @returns {string[]}
 */
function splitReplyForSend(text, maxChars) {
  const body = String(text || '').replace(ZERO_WIDTH_RE, '').trim();
  if (!body) return [body];
  if (Array.from(body).length < SPLIT_MIN_LENGTH) return [body];
  const sentences = splitSentences(body);
  if (sentences.length <= 1) return [body];
  const parts = mergeToMaxCount(sentences, SPLIT_MAX_COUNT);
  // 合并后仍有单条超过上限：拆分帮不了忙，回原文。
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Infinity;
  if (parts.some((part) => Array.from(part).length > limit)) return [body];
  // 拆了反而每条都一样长就别拆：只认"至少能拆出一条明显更短的"。
  if (parts.length > 1 && parts.every((part) => Array.from(part).length >= Array.from(body).length)) return [body];
  // 只有真正切出多段才拆；mergeToMaxCount 返回的单元素数组说明内容连不成几条。
  if (parts.length <= 1) return [body];
  return parts;
}
