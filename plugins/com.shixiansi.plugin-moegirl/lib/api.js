// lib/api.js —— 萌娘百科的两步查询（纯函数在这一层，网络在 app.js）
//
// 为什么是两步，而不是一次 `list=search`：
//
//   2026-10-30 实测：`action=query&list=search` 被站点关了匿名调用，返回
//   `{"error":{"code":"action-notallowed","info":"Unauthorized API call"}}`——想靠搜索引擎式的
//   接口取结果，这条路直接封死。而这两个接口是开的：
//
//     action=opensearch&search=…            → ["原神", ["原神", "原神/用语与梗", …], …]
//     action=query&prop=extracts&exintro=1  → 条目的开头几段纯文本
//
//   所以：**先用 opensearch 把用户那句话解析成一个真实条目名**（它顺带处理了别名与重定向：
//   问「区」就给出条目「区」），再用 extracts 取正文首段。两步都要，缺一步就会把整句话当成条目名。
'use strict';

const API = 'https://zh.moegirl.org.cn/api.php';
const UA = 'PetPC-Moegirl/0.1 (+desktop pet plugin)';

/** opensearch：把用户输入解析成最可能的条目名。 */
function openSearchURL(query, limit) {
  return `${API}?action=opensearch&format=json&limit=${Math.max(1, Math.min(10, limit || 3))}`
    + `&search=${encodeURIComponent(String(query || ''))}`;
}

/** extracts：取条目的开头（`exintro` 只要序言，`explaintext` 不要 HTML）。 */
function extractURL(title, maxChars) {
  const chars = Math.max(120, Math.min(4000, Number(maxChars) || 600));
  return `${API}?action=query&format=json&prop=extracts&exintro=1&explaintext=1`
    + `&exchars=${chars}&titles=${encodeURIComponent(String(title || ''))}`;
}

/** opensearch 的返回是 `[query, [titles], [descs], [urls]]`——取标题与 URL 对齐。 */
function parseOpenSearch(body) {
  let parsed;
  try {
    parsed = JSON.parse(String(body || ''));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const titles = Array.isArray(parsed[1]) ? parsed[1] : [];
  const urls = Array.isArray(parsed[3]) ? parsed[3] : [];
  return titles.map((title, index) => ({
    title: String(title || '').trim(),
    url: String(urls[index] || `https://zh.moegirl.org.cn/${encodeURIComponent(String(title || ''))}`),
  })).filter((row) => row.title);
}

/** extracts 的返回：`{query:{pages:{"<pageid>":{title, extract, missing?}}}}`。 */
function parseExtract(body) {
  let parsed;
  try {
    parsed = JSON.parse(String(body || ''));
  } catch {
    return null;
  }
  const pages = (parsed && parsed.query && parsed.query.pages) || null;
  if (!pages) return null;
  for (const key of Object.keys(pages)) {
    const page = pages[key] || {};
    if (page.missing !== undefined) continue;
    const extract = String(page.extract || '').trim();
    if (!extract) continue;
    return { title: String(page.title || ''), extract, pageId: String(page.pageid || key) };
  }
  return null;
}

/** 把首段收拾成一句能读的摘要：压空白、去掉目录式的空行。 */
function tidyExtract(text, maxChars) {
  const cap = Math.max(120, Math.min(4000, Number(maxChars) || 600));
  const body = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (body.length <= cap) return body;
  // 截断优先落在句末，读起来才不像被切断的。
  const head = body.slice(0, cap);
  const stop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'));
  return stop > cap * 0.5 ? head.slice(0, stop + 1) : `${head}…`;
}

/** 给模型读的一段话：条目 + 摘要 + 出处。空摘要返回空串（调用方据此"什么都没查到"）。 */
function renderEntry(entry, maxChars) {
  if (!entry || !entry.extract) return '';
  const body = tidyExtract(entry.extract, maxChars);
  if (!body) return '';
  return [
    // **自报身份**：核心的人设里常写着"只用给你的记忆回答"，于是它会把这坨查到的资料当成
    // "不属于我的记忆"而忽略（2026-10-30 实测：注入成功了，模型仍回"是不是打错了"）。
    // 所以这一段要自己说清楚：这是**查到的资料**，不是记忆，下面就是要用的内容。
    `【萌娘百科·已查到】用户这句话里的「${entry.title}」有词条，下面是原文；直接按它回答，`
      + '不要说"不知道"，也不要猜是不是打错了：',
    // 从消歧义页降级下来的要说明一句：否则模型看到「区」的答案讲的是「区(网络用语)」会犯疑。
    ...(entry.from ? [`（这一条取自「${entry.from}」的分条「${entry.title}」${entry.alsoTitles && entry.alsoTitles.length ? `，同名的还有：${entry.alsoTitles.join('、')}` : ''}）`] : []),
    body,
    `（来源：萌娘百科 ${entry.url || `https://zh.moegirl.org.cn/${encodeURIComponent(entry.title)}`}，CC BY-NC-SA 3.0 CN）`,
  ].join('\n');
}

/**
 * 存储键的一段：djb2 的 36 进制写法（只有字母数字）。
 *
 * 为什么不能直接用 `encodeURIComponent`：宿主的存储键每段只允许 `[A-Za-z0-9_-]`（手册 §6.3），
 * 而中文编码出来是 `%E6%97%B6…`——`%` 直接让整次 `storage.get` 不执行。2026-10-30 的日志里就是
 * 一条这样的 WARN，缓存等于从来没命中过。
 *
 * 哈希会有碰撞，所以**读缓存时还要比对 `query`**（见 app.js）：撞了就当没命中，绝不能把另一个
 * 词条的释义当成这个词的。
 */
function cacheKeyOf(query) {
  const body = String(query || '');
  let h = 5381;
  for (let i = 0; i < body.length; i += 1) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}-${body.length.toString(36)}`;
}

/**
 * 消歧义条目？——「区」这种：「区可以指：区(月亮计划)……、区(网络用语)……」
 *
 * 这类条目的**序言本身没有内容**，只有一串链接。2026-10-30 实测：用户问「区」，拿到的是
 * "区可以指：…区(网络用语)——一种网络用语"，等于什么都没说。而子条目 `区(网络用语)` 是有正文的，
 * 所以查词时要能认出这种页面、往下降一级。
 */
function isDisambiguation(extract) {
  const body = String(extract || '').trim();
  if (!body) return false;
  // 只认开头那一段：正文里偶尔也会出现"可以指"这样的词，不能凭它判定整篇是消歧义页。
  const head = body.slice(0, 200);
  return /(可以指|可能指|也可指|是指以下几|可指)/.test(head) && /——|--/.test(body);
}

/**
 * 从消歧义页里取出候选子条目：`区(月亮计划)————游戏《脑叶公司》…` 这种行。
 *
 * 返回 `[{title, note}]`，`note` 是破折号后面那半句（给人看的提示，也用来挑最相关的那一个）。
 */
function parseDisambiguationTitles(extract) {
  const out = [];
  for (const raw of String(extract || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 破折号两侧：左边是条目名，右边是说明。分隔符是 2 个以上 `-` 或 `—`。
    const matched = /^(?<title>[^—\-]{1,60}?)\s*[—-]{2,}\s*(?<note>.*)$/.exec(line);
    if (!matched || !matched.groups) continue;
    const title = String(matched.groups.title || '').trim();
    if (!title) continue;
    out.push({ title, note: String(matched.groups.note || '').trim() });
  }
  return out;
}

/**
 * 挑最像"用户想问的那个意思"的子条目。
 *
 * 排序依据（都是明写的偏好，不是猜测）：
 *   1. 名字以查询词开头（`区(网络用语)` 之于 `区`）；
 *   2. 名字或说明里带**网络/用语/梗/俚语/黑话/弹幕**这类词——这个插件的立身之本就是网络词；
 *   3. 其余按页面顺序。
 *
 * 名字里带括号的（`区(月亮计划)`）说明它是从同名主条目分出来的，比不带括号的更可能是"那个意思"。
 */
function pickSubEntry(query, candidates) {
  const term = String(query || '').trim();
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.title) : [];
  if (!list.length) return null;
  const webish = /网络|用语|梗|俚语|黑话|弹幕|流行/;
  const score = (row) => {
    let value = 0;
    if (term && row.title.startsWith(term)) value += 4;
    if (row.title.includes('(') || row.title.includes('（')) value += 1;
    if (webish.test(row.title)) value += 3;
    if (webish.test(row.note || '')) value += 2;
    return value;
  };
  return list
    .map((row, index) => ({ row, index, value: score(row) }))
    .sort((a, b) => (b.value - a.value) || (a.index - b.index))[0].row;
}

const MOEGIRL_PURE = {
  isDisambiguation,
  parseDisambiguationTitles,
  pickSubEntry,
  cacheKeyOf, openSearchURL, extractURL, parseOpenSearch, parseExtract, tidyExtract, renderEntry, API, UA };
