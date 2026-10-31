// lib/xml.js —— 极简 RSS 2.0 / Atom 解析器
//
// 为什么自己写而不是引入 rss-parser：插件是沙箱 iframe（手册 §10），跑在宿主给的 zip
// 里的是**包内**的经典脚本——没有 Node 的 require，也没有一个能装 npm 包的构建步骤。
// 纯 JS 手写一个够用的解析器，比把一个 DOM 依赖的库塞进包里更可控。
//
// 够用 = 从一段 XML 里按标签名掏出**条目**与它们的几个字段。不做完整 DOM、不验证
// DTD、不处理 XSL；CDATA 与实体是要处理的（否则标题里的 &amp; 会一路带进 prompt）。
//
// 两个格式都归一化成同一种条目：
//
//   RSS 2.0  <item><title>…</title><link>…</link><pubDate>…</pubDate><description>…</description></item>
//   Atom     <entry><title>…</title><link href="…"/><updated>…</updated><summary>…|<content>…</entry>
//
// 命名空间前缀（<content:encoded>）按**本地名**匹配：RSS 生态里 content:encoded 是
// 全文最常见的写法，前缀叫什么无所谓。

'use strict';

/** 有限的一组 XML 实体 + 十进制/十六进制数字引用。完整的 DTD 实体表不是这里的事。 */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCode(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // 最后：&amp; 是"转义的 &"
}

function safeFromCode(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 剥一层 CDATA（可嵌套出现一次就够：真实的 feed 里没有嵌套 CDATA）。 */
function stripCdata(text) {
  const m = String(text || '').match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  return m ? m[1] : String(text || '');
}

/** 取一个标签的**内部文本**（第一个匹配；跳过自闭合）。 */
function tagContent(xml, tagName) {
  const local = tagName.replace(/^[\w.-]+:/, '');
  // 本地名匹配：content:encoded 与 <encoded> 都算。
  const re = new RegExp(`<(?:[\\w.-]+:)?${escapeRegExp(local)}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${escapeRegExp(local)}>`, 'i');
  const m = String(xml || '').match(re);
  if (!m) return '';
  return decodeEntities(stripCdata(m[1])).trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 一个块（item/entry）里的所有 <link>：Atom 的地址在 href 属性上，RSS 在文本里。 */
function linkOf(block) {
  const href = String(block || '').match(/<link\s[^>]*href\s*=\s*["']([^"']+)["']/i);
  if (href) return decodeEntities(href[1]).trim();
  const text = tagContent(block, 'link');
  if (text) return text;
  const guid = tagContent(block, 'guid');
  return /^https?:\/\//i.test(guid) ? guid : '';
}

/** 去掉残留的 HTML 标签与多余空白：description 里常有 <p>。 */
function plainText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** RFC822 与 ISO8601 都交给 Date：解析不出返回 0（排序时沉底，不报错）。 */
function parseDate(value) {
  const ms = Date.parse(String(value || '').trim());
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 解析一份 feed 文本。
 *
 * @param {string} raw 抓回来的 XML（net.fetch 的 text 形态）
 * @returns {{kind: 'rss'|'atom'|'', title: string, items: Array<{title, link, published, summary}>}}
 */
function parseFeed(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, ''); // 去 BOM
  const isAtom = /<feed[\s>]/i.test(text) && /<entry[\s>]/i.test(text);
  const kind = isAtom ? 'atom' : /<item[\s>]/i.test(text) ? 'rss' : '';
  const title = plainText(tagContent(text, 'title'));

  if (!kind) return { kind: '', title, items: [] };

  const blocks = kind === 'atom'
    ? splitBlocks(text, 'entry')
    : splitBlocks(text, 'item');

  const items = blocks.map((block) => {
    const link = linkOf(block);
    const summary = kind === 'atom'
      ? plainText(tagContent(block, 'summary') || tagContent(block, 'content'))
      : plainText(tagContent(block, 'description') || tagContent(block, 'content:encoded'));
    const published = parseDate(
      kind === 'atom'
        ? (tagContent(block, 'published') || tagContent(block, 'updated'))
        : tagContent(block, 'pubDate'),
    );
    return {
      title: plainText(tagContent(block, 'title')) || link || '（无标题）',
      link,
      published,
      summary,
    };
  });

  return { kind, title, items };
}

/** 按标签把顶层块切开（不数嵌套：RSS/Atom 的 item 里不会再有 item）。 */
function splitBlocks(xml, tagName) {
  const local = tagName.replace(/^[\w.-]+:/, '');
  const re = new RegExp(`<(?:[\\w.-]+:)?${escapeRegExp(local)}[\\s>]`, 'gi');
  const opens = [];
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    opens.push(m.index);
  }
  const closeRe = new RegExp(`</(?:[\\w.-]+:)?${escapeRegExp(local)}>`, 'gi');
  const closes = [];
  while ((m = closeRe.exec(String(xml || ''))) !== null) {
    closes.push(m.index + m[0].length);
  }
  // 开闭配对：第 i 个开对应第 i 个闭（feed 不会交错）。
  const blocks = [];
  for (let i = 0; i < opens.length && i < closes.length; i += 1) {
    if (closes[i] > opens[i]) blocks.push(String(xml).slice(opens[i], closes[i]));
  }
  return blocks;
}

/** 一段"剥好的"正文：压空白、截断。给 digest 与预览用。 */
function excerpt(item, maxChars) {
  const body = plainText(`${item.title}。${item.summary}`.replace(/^。/, ''));
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 600;
  return body.length > limit ? `${body.slice(0, limit)}…` : body;
}
