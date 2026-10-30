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
    `【萌娘百科】${entry.title}`,
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

const MOEGIRL_PURE = {
  cacheKeyOf, openSearchURL, extractURL, parseOpenSearch, parseExtract, tidyExtract, renderEntry, API, UA };
