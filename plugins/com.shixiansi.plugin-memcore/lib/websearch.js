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

/**
 * 搜索的后备链。**先搜全网，搜不到就搜 B 站。**
 *
 * 为什么不只留一家：搜索引擎对"网络梗 / 二创术语 / UP 主黑话"经常一片空白——它们没有词条，
 * 或者词条是几天前的烂梗。而 B 站站内搜索恰好是这些词的富矿：视频标题与简介就是"大家平时怎么
 * 用这个词"的现场记录。反过来，B 站搜不到新闻、文档、百科，所以两家是互补而不是替代。
 *
 * 顺序是"全网优先"：一般问题搜索引擎更快更准，B 站是**补位**。只有前一家**一条结果都没有**
 * （或者它自己失败/没装/没配好）才问下一家——不是每次都问两遍，那要多花一次往返。
 */
/**
 * 整个搜索步骤的时间上限（毫秒）。
 *
 * 宿主 `plugin.call` 是 30 秒，而一句话里还要塞两轮模型调用（实测各 1.5–2.5 秒）。2026-10-30
 * 真机就撞了线：`plugin.call 等 com.shixiansi.plugin-memcore/chat 的回答超时（30 秒）`——因为
 * 那台 SearXNG 单次要 20 秒，加上第二轮模型就把额度花光了。
 *
 * 所以搜索这一步自己封顶 12 秒，并且给"后面那一家"留 3 秒（B 站约 0.2 秒，够用）。到点就带着
 * 已有信息回答，绝不让调用方干等超时。
 */
const SEARCH_BUDGET_MS = 12000;
/** 后面还有别的搜索目标时，给它们留的余量（毫秒）。 */
const SEARCH_RESERVE_MS = 3000;

const SEARCH_TARGETS = [
  { id: 'com.shixiansi.plugin-websearch', method: 'search' },
  { id: 'com.shixiansi.plugin-bilibili', method: 'search' },
];

/**
 * "这句话在问 B 站上的东西"——命中就把 B 站排到**第一顺位**。
 *
 * 为什么需要这条：只按"结果数是不是 0"决定要不要换一家，在真机上直接失效。2026-10-30 实测：
 * 用户问「看一下b站原神现在的最新pv叫啥，链接发来」，搜索引擎返回了 5 条**非空但没用**的结果：
 * 哔哩哔哩热门、下载中心、UP主专栏、微软商店、一个山寨站——一条原神 PV 都没有。于是后备链
 * 判定"搜到了"，不去问 B 站，模型只能如实说查不到。而 B 站站内搜索同一句话第一条就是
 * 「「原神」新角色PV」（实测 code 0，20 条结果）。
 *
 * 判据用"词面意图"而不是给结果打分：打分要判断相关性，脆且不可解释；而"用户说了 B 站/视频/PV"
 * 是硬信号。命中就 B 站优先——顺带省掉搜索引擎那一次 20 秒的往返。
 */
// `\b` 对中文不成立（`\w` 只含 ASCII）：`up主`/`pv` 这些混排词要用前后断言，
// 否则 `\bup\s*主\b` 的尾边界永远不成立，`UP主推荐` 会被判成整网优先。
const BILI_INTENT_RE = /(b\s*站|哔哩哔哩|bilibili|视频|番剧|鬼畜|二创|投稿|弹幕|直播|up\s*主|(?<![a-z])pv(?![a-z]))/i;

/** 这一轮先问谁：明显在问 B 站的东西就 B 站优先，否则整网优先。 */
function searchOrder(query) {
  const bili = SEARCH_TARGETS[1];
  const web = SEARCH_TARGETS[0];
  return BILI_INTENT_RE.test(String(query || '')) ? [bili, web] : [web, bili];
}

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

/**
 * 模型按提示词约定给出的 `[SEARCH] 要查的话`：取出那句查询（没有就是空串）。
 *
 * 这个出口以前**只有写进提示词、没有解析**（`SEARCH_TAG_RE` 只在 `wantsSearchFor(line)` 里用过，
 * 而那是**用户**那句话）。于是模型老老实实回了 `[SEARCH] …`，这边既不搜、也不认，还把这个标记
 * 原样发给了用户。2026-10-30 用户报"记忆插件不会调用插件"，日志里就是这条：
 *
 *     llm.chat 收到（25 字）：[SEARCH] “区”在网络用语中是什么意思
 *
 * 之后没有任何 plugin.call。
 */
function searchTagOf(reply) {
  const matched = SEARCH_TAG_RE.exec(String(reply || ''));
  return matched ? text(matched[1], 300).trim() : '';
}

/** 把 `[SEARCH]` 那一行从回答里去掉：用户不该看到这个标记。 */
function stripSearchTag(reply) {
  return String(reply || '').replace(SEARCH_TAG_RE, '').trim();
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
async function askOne(target, query, count, timeoutMs) {
  try {
    const out = await request('plugin.call', {
      target: target.id,
      method: target.method,
      // `timeoutMs` 是可选的：联网搜索插件据此提前放弃，于是我们能赶在预算内换下一家。
      // 老版本的插件会忽略这个字段，所以外面还要有一道 race（见 askWebSearch）。
      payload: timeoutMs ? { query, count, timeoutMs } : { query, count },
    });
    if (!out || typeof out.text !== 'string' || !out.text.trim()) return null;
    const results = Array.isArray(out.results) ? out.results : [];
    // 一条结果都没有 = 这一家没帮上忙 → 让调用方换下一家（而不是把它当成"搜过了"）。
    if (!results.length) return null;
    return {
      text: out.text,
      engine: typeof out.engine === 'string' ? out.engine : '',
      results,
    };
  } catch {
    // 目标没装 / 未启用 / 没声明在 callTargets 里 / 超时（plugin.call 的 30 秒上限）：
    // 一律当作"这一家问不到"，接着问下一家。
    return null;
  }
}

async function askWebSearch(query, count) {
  // 同 slang：说话人前缀对搜索没有意义（`lookupQueryOf` 在 lib/slang.js 里）。
  const trimmed = text(lookupQueryOf(query), 300).trim();
  if (!trimmed) return null;
  const targets = searchOrder(trimmed);
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  for (let i = 0; i < targets.length; i += 1) {
    const left = deadline - Date.now();
    const reserve = i === targets.length - 1 ? 0 : SEARCH_RESERVE_MS;
    const budget = left - reserve;
    if (budget < 1500) continue; // 剩下的时间不够问这一家，直接看下一家
    const hit = await Promise.race([
      askOne(targets[i], trimmed, count, budget - 500),
      // 兜底：目标插件可能不认识 timeoutMs（老版本），到点就不再等它。
      new Promise((resolve) => setTimeout(() => resolve(null), budget)),
    ]);
    if (hit) return hit;
  }
  return null;
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
