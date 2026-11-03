// lib/extract.js —— 内容指纹 + 从抓回来的 HTML 里取出"该比对的那段字"
//
// 两层同在一个文件里，因为它们是同一件事的两半。**取值**是成败所在：直接哈希整份 HTML 的监控器
// 第一天就报警，因为真实页面里每时每刻在变的东西跟内容无关——script/style 里的构建号、注释里的渲染
// 时间戳、广告位的随机 token、模板缩进。所以顺序是：先按 CSS 选择器缩到那一块（命中就只认那一块），
// 再把它变成一段人读得懂的字（去掉 script/style/noscript/template 与注释、折叠连续空白（含全角
// 空格与零宽字符）），最后才哈希。用 DOMParser 而不是手写解析器：它给出的文档是**惰性**的（脚本
// 不执行、图片不加载、不发网络请求），把陌生站点的 HTML 丢进去不会引出副作用。**指纹**是 16 位
// 十六进制的内容哈希（两条 32 位链）。为什么不存两份全文再逐字符 diff：两份全文会长大（一个商品页
// 几十 KB，8 条监控每轮两份 = 把私有目录当聊天记录），而我们要回答的只有「变了没有」（一个指纹）
// 与「哪一段看着变了」（两小段 ≤160 字摘录）。

'use strict';

/** 这几个标签里的东西一定不是页面内容（`iframe` 的内容本来就不在 HTML 里，是空元素）。 */
const NOISE_TAGS = ['script', 'style', 'noscript', 'template'];

/** 参与哈希的字数上限：够长到"整页都算"，又不至于让一次抓取把主线程按上几十毫秒。 */
const MAX_TEXT_CHARS = 200000;

function stripComments(html) {
  return String(html === undefined || html === null ? '' : html).replace(/<!--[\s\S]*?-->/g, '');
}

/** HTML → 惰性文档；解析失败（或空）返回 null。 */
function parseHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    return doc && doc.body ? doc : null;
  } catch {
    return null;
  }
}

function removeNoise(root) {
  for (const tag of NOISE_TAGS) {
    const nodes = root.querySelectorAll(tag);
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }
}

/**
 * 把一段文本折成"只剩内容"的形状。全角空格（U+3000）、不换行空格（U+00A0）与零宽字符
 * （U+200B..U+200F）在中文页面上极常见，而 `\s` **不认**它们——不先统一掉，"同样的内容"
 * 会因为一个不可见字符被判成变化。
 */
function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取前 n 个字（界面与气泡里说"变的是这一段"用的就是它）。 */
function excerpt(value, n) {
  const s = String(value === undefined || value === null ? '' : value);
  const limit = Number.isFinite(n) && n > 0 ? n : 120;
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * "哪一段看着变了"：两段**摘录**的公共前缀之后的那一小段。故意不是 diff——我们手里只有两段
 * ≤160 字的摘录，够回答"变的是这一段"，不够也不该去重建整页。两段相同返回空串。
 */
function snippetAround(before, after, size) {
  const a = String(after === undefined || after === null ? '' : after);
  const b = String(before === undefined || before === null ? '' : before);
  const width = Number.isFinite(size) && size > 0 ? size : 48;
  if (!a || a === b) return '';
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  const start = Math.max(0, i - Math.floor(width / 4));
  const piece = a.slice(start, start + width).trim();
  if (!piece) return '';
  return `${start > 0 ? '…' : ''}${piece}${start + width < a.length ? '…' : ''}`;
}

/**
 * 从一份 HTML 里取出要比对的那段字。ok:false 时 `reason` 是一句能直接显示给用户的中文——
 * "选择器没命中"不是崩溃，是这一轮抓失败，而且**绝不允许**当成"内容变成空"（那会让下一轮把
 * "从空变成内容"当成一次变化播报出去）。
 */
function extractContent(html, selector) {
  const raw = String(html === undefined || html === null ? '' : html);
  if (!raw.trim()) return { ok: false, reason: '抓回来的是空页面（可能要等脚本渲染，或者这个站拒绝了请求）' };
  const doc = parseHtml(stripComments(raw));
  if (!doc) return { ok: false, reason: '抓回来的东西解析不了（不像 HTML）' };
  removeNoise(doc.body);

  const sel = String(selector === undefined || selector === null ? '' : selector).trim();
  let target = doc.body;
  if (sel) {
    try {
      target = doc.querySelector(sel);
    } catch {
      return { ok: false, reason: `CSS 选择器写错了：${text(sel, 80)}（浏览器不认这个写法）` };
    }
    // 页面改版、商品下架、选择器写错——三种都只能算"这一轮没抓到"。
    if (!target) return { ok: false, reason: `选择器没有命中：${text(sel, 80)}（页面可能改版了）` };
  }

  const body = normalizeText(target.textContent || '').slice(0, MAX_TEXT_CHARS);
  if (!body) {
    return { ok: false, reason: sel ? `「${text(sel, 60)}」这一块现在是空的（脚本渲染的站点抓不到文字）` : '这一页没有可读的正文（脚本渲染的站点抓不到文字）' };
  }
  return { ok: true, text: body, scope: sel || '（整页正文）' };
}

// --- 指纹 ---------------------------------------------------------------------

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');

/**
 * 一段文本的指纹：16 个十六进制字符。
 *
 * 两条链用不同的乘法子，并且第二条把位置与第一条的中间值也搅进来——这样两个长度不同但字符
 * 多重集合相同的文本（"3.50 库存 2" 与 "2 库存 3.50"）不会撞在一起。
 */
function hashText(input) {
  const s = String(input === undefined || input === null ? '' : input);
  let a = 0x811c9dc5; // FNV offset basis
  let b = 0x9e3779b9;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    // 位置也进第二条链：换行/空白的挪动在"每行一个价格"的页面上正是要抓住的变化。
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0;
    b = (b + (a & 0xffff)) >>> 0;
  }
  return hex8(a) + hex8(b);
}
