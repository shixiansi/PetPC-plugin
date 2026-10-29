// lib/websearch.js —— 「记忆答不上 → 先查再答」的那一步
//
// 联网是**借来的能力**：真正的搜索住在「联网搜索」插件里（它才有 net.fetch 与引擎配置），
// 这里只用 plugin.call 问它。于是三件事自动成立：
//
//   · 白名单与密钥只有一个地方管（搜索插件的 manifest 与 config）；
//   · 搜索插件没装 / 没启用时，这里拿到的是宿主那句中文（「未启用」「问不到 …」），
//     兜底就是"当没有搜索"，对话绝不因为搜索挂掉而失败；
//   · 换一个搜索引擎，核心一行代码都不用改。
//
// 三档模式（config: webSearch）：
//
//   off     纯记忆，一次搜索都不发（与 0.1.x 的行为完全一致）。
//   always  每一轮都先查再答：时效性问题不该赌记忆。
//   auto    默认档。三条触发线，按"记忆答不上"的本意收窄：
//             1. 用户这轮明确要查（「帮我查…」「搜一下…」）→ 先查再答；
//             2. 模型按 prompt 约定输出 [SEARCH] 要查的话 → 先查再答；
//             3. 第一答是「不知道」类回答 → 查一次，带着结果再答一次。
//           代价：触发的这一轮会多花一到两次模型请求——买的是"记忆里有的东西不上网"。
//
// WHY 检测而不是让模型自由决定：宿主的 llm.chat 工具目录里没有 web_search，模型没有
// "我要搜"的出口；把决定权放在这三条硬信号上，比"让模型看着办"可预期。

'use strict';

const SEARCH_TARGET = 'com.shixiansi.plugin-websearch';
const SEARCH_METHOD = 'search';

/** 回答里出现这些信号 = 模型在说"我答不了"（只匹配"没答上"，不匹配"提到了新词"）。 */
const NO_ANSWER_RE = /(我不知道|我不清楚|我不了解|我没听过|我不记得|记不得|想不起来|没[法办]回答|答不了|答不上|无法回答|不太确定|没有相关的?(记忆|信息|资料)|找不到相关的?)/;

/** 用户这一轮明确要查：直接先查再答，不用赌第一答。 */
const USER_SEARCH_RE = /(帮我查|帮我搜|搜索一下|搜一下|上网查|网上查|查一下|去搜)/;

/** 模型按 prompt 约定主动要一次搜索的前缀。 */
const SEARCH_TAG_RE = /^\s*\[SEARCH\]\s*(.+)/;

function searchMode() {
  const mode = String(cfg.webSearch || 'auto').trim().toLowerCase();
  return mode === 'always' || mode === 'off' || mode === 'auto' ? mode : 'auto';
}

function searchCount() {
  return num('webSearchCount', 1, 10, 5);
}

/** 这一句要不要在第一问之前就搜（用户的明确要求，或模型的 [SEARCH] 出口）。 */
function wantsSearchFor(line) {
  const body = String(line || '');
  return USER_SEARCH_RE.test(body) || SEARCH_TAG_RE.test(body);
}

/** 一次模型的回答算不算"没答上"（auto 档的第二条触发线）。 */
function looksLikeNoAnswer(reply) {
  return NO_ANSWER_RE.test(String(reply || ''));
}

/**
 * 问搜索插件查一次。任何失败都返回 null——搜索是增强，不是依赖：
 * 插件没装、没启用、没配好、超时，全部走这一条路。
 *
 * @returns {Promise<{text:string, engine:string, results:Array}|null>}
 */
async function askWebSearch(query, count) {
  const trimmed = text(query, 300).trim();
  if (!trimmed) return null;
  try {
    const out = await request('plugin.call', {
      target: SEARCH_TARGET,
      method: SEARCH_METHOD,
      payload: { query: trimmed, count },
    });
    if (!out || typeof out.text !== 'string' || !out.text.trim()) return null;
    return {
      text: out.text,
      engine: typeof out.engine === 'string' ? out.engine : '',
      results: Array.isArray(out.results) ? out.results : [],
    };
  } catch {
    // 目标没装 / 未启用 / 超时（plugin.call 的 30 秒上限）：全部当作"没有搜索"。
    return null;
  }
}

/** auto 档的第一问之前，告诉模型有一个 [SEARCH] 出口。 */
function searchInstruction() {
  return [
    '【联网】你可以先上网查资料再回答：',
    '- 只想在记忆之外补充资料时，第一行只写「[SEARCH] 要查的话」，不要写别的；',
    '- 收到【网页搜索结果】后，按资料回答，并自然地提一句来源；资料里没有的就别编。',
  ].join('\n');
}

/** 把一次搜索的结果拼进 system。 */
function searchBlock(result) {
  return `【网页搜索结果】\n${result.text}`;
}
