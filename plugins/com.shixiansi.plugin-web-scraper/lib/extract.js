// lib/extract.js —— 正文评分与提取（纯函数，不碰 DOM API）
//
// 为什么不用 DOMParser 做评分：插件包要能在 jsdom 与真 iframe 两个环境里被同一套测试驱动，
// 评分器必须对输入 HTML 是唯一裁判——它拿到的就是一串标记文本，自己数标签、自己配对。
// DOMParser 只在后面清洗"选中的正文 HTML"时用（workshop.js）。
//
// 算法四步：
//   1. 预清洗：注释/doctype/head 整段去掉；script/style 等连同内容剔除；
//      nav/footer/aside 整块噪音丢掉；空白压成单空格。
//   2. 候选生成：单遍扫描标签，按栈配对；每个块级容器（article/main/section/div/body）
//      闭合并配对成功时记一条候选 {范围, 标签, class/id}。
//   3. 评分：段落数、正文长度、逗号数是正面信号；链接密度是导航信号（重罚）；
//      类名/ID 关键词加减分，命中负面词直接淘汰。
//   4. 选择：得分 > 0 的候选里取最高分；并列取开标签更早的。全军覆没时回退
//      "段落合并"——把所有像正文的 <p> 串起来（广告页兜底）。

'use strict';

/** 连同内容一起剔除的标签（脚本与控件，不是文章的一部分）。 */
const STRIP_TAGS = ['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'form', 'button', 'select', 'input', 'textarea', 'label', 'object', 'embed', 'video', 'audio', 'figure', 'figcaption'];

/** 整块噪音容器：内容直接当噪音丢掉。 */
const NOISE_CONTAINERS = ['nav', 'aside'];

/** 参与候选评分的块级容器。header/footer 不进来——它们在 NOISE/负关键词里另有处置。 */
const CONTAINER_TAGS = ['article', 'main', 'section', 'div', 'body'];

/** 类名/ID 关键词 → 加分。 */
const POSITIVE_KEYWORDS = [
  ['markdown-body', 60], ['topic-content', 45], ['article', 40], ['article-', 35],
  ['-article', 35], ['post-content', 45], ['entry-content', 45], ['content', 35],
  ['story', 25], ['rich-text', 30], ['rich_media', 30], ['post', 20], ['entry', 20],
  ['main', 15], ['body', 15], ['text', 15],
];

/** 类名/ID 负面关键词：命中一次重罚并直接淘汰（评论区/侧栏/推广位）。 */
const NEGATIVE_KEYWORDS = [
  'comment', 'sidebar', 'promo', 'sponsor', 'advert', 'advert-', 'banner', 'related',
  'recommend', 'share', 'social', 'footer', 'breadcrumb', 'pagination', 'widget',
  'popup', 'modal', 'ads', 'adbox', 'newsletter', 'subscribe', 'copyright', 'breadcrumb',
  'menu', 'nav',
];

/** HTML 的 void 元素：永远不会闭合。 */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** 基本实体 + 数字实体。 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', copy: '©', reg: '®', trade: '™' };

function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body.charAt(0) === '#') {
      const code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** 去掉所有标签，只留文本（不做实体解码——调用方决定）。 */
function stripTags(html) {
  return String(html ?? '').replace(/<[^>]*>/g, '');
}

/** 去标签 + 解实体 + 压空白：给"数文本长度"用。 */
function textOf(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

/**
 * 预清洗：让后面的配对扫描只面对"有意义的"标签流。
 * 返回 { html, title }——title 在 head 被删之前抓出来。
 */
function preClean(rawHtml) {
  let html = String(rawHtml ?? '');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? textOf(titleMatch[1]) : '';
  html = html.replace(/<!--[\s\S]*?-->/g, ' ');
  html = html.replace(/<!doctype[^>]*>/gi, ' ');
  html = html.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  // head 整段不要（样式表、feed 发现、说明文字都在里面）。header ≠ head：带词边界。
  html = html.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ');
  for (const tag of STRIP_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    html = html.replace(re, ' ');
    // 没闭合的孤儿开标签也丢掉，防止评分时把它的 class 当正文容器。
    html = html.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), ' ');
  }
  for (const tag of NOISE_CONTAINERS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    html = html.replace(re, ' ');
    html = html.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), ' ');
  }
  html = html.replace(/[\t\n\r\f\v]+/g, ' ').replace(/ {2,}/g, ' ');
  return { html, title };
}

/** 从属性串里抠 class/id 的值（引号可有可无）。 */
function attrValue(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!m) return '';
  return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
}

/**
 * 单遍扫描 + 栈配对，产出所有块级容器的完整闭合候选。
 * 浏览器式的容错：遇到 `</tag>` 先看栈顶，不是就往栈底找最近的同名开标签，
 * 找到则把它上面的全部一起弹掉（隐式闭合），没找到就忽略这个游离闭标签。
 */
function findCandidates(clean) {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack = []; // { tag, start, attrs }
  const candidates = [];
  let m;
  while ((m = tagRe.exec(clean)) !== null) {
    const isClose = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (VOID_TAGS.has(tag)) continue;
    if (!isClose) {
      if (CONTAINER_TAGS.includes(tag)) stack.push({ tag, start: m.index, attrs });
      continue;
    }
    // 闭标签：自栈顶向下找同名开标签。
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].tag === tag) { idx = i; break; }
    }
    if (idx < 0) continue;
    // 弹掉 idx 之上的所有未闭合容器（它们没有完整闭合，不产生候选）。
    for (let i = stack.length - 1; i > idx; i -= 1) stack.pop();
    const open = stack.pop();
    if (!CONTAINER_TAGS.includes(open.tag)) continue;
    const openTagLen = (clean.slice(open.start).match(/^[^>]*>/) || ['>'])[0].length;
    candidates.push({
      tag: open.tag,
      start: open.start,
      end: m.index + m[0].length,
      // 开标签之后、闭标签之前才是"内部"。openTagLen 已含 '<'，不能再 +1。
      innerStart: open.start + openTagLen,
      innerEnd: m.index,
      attrs: open.attrs,
    });
  }
  return candidates;
}

/** 候选内链接文本总长（锚点按非贪婪配对）。 */
function linkTextLength(fragment) {
  let total = 0;
  const re = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(fragment)) !== null) total += textOf(m[1]).length;
  return total;
}

/** 类名/ID 关键词得分：正面求和（封顶 100），负面每 hit -80 且强制淘汰。 */
function classScore(attrs) {
  const cls = `${attrValue(attrs, 'class')} ${attrValue(attrs, 'id')} ${attrValue(attrs, 'itemprop')} ${attrValue(attrs, 'role')}`.toLowerCase();
  if (!cls.trim()) return { score: 0, rejected: false, hits: [] };
  let score = 0;
  let rejected = false;
  const hits = [];
  for (const [word, pts] of POSITIVE_KEYWORDS) {
    if (cls.includes(word)) { score += pts; hits.push(`${word}+${pts}`); }
  }
  score = Math.min(score, 100);
  for (const word of NEGATIVE_KEYWORDS) {
    if (cls.includes(word)) { score -= 80; rejected = true; hits.push(`${word}罚`); }
  }
  return { score, rejected, hits };
}

/**
 * 纯打分：给一段 HTML 片段 + 它所在容器的标签/属性，给出分数。
 * 谁调它决定片段里是什么——单个候选的"排他内容"，或同键兄弟组的"合并内容"。
 */
function scoreFragment(fragment, tag, attrs) {
  const text = textOf(fragment);
  const textLen = text.length;
  const paraCount = (fragment.match(/<p[\s>]/gi) || []).length;
  const commaCount = (text.match(/[，,、]/g) || []).length;
  const linkLen = linkTextLength(fragment);
  const linkDensity = textLen > 0 ? linkLen / textLen : 0;
  const cls = classScore(attrs);

  let score = 0;
  score += Math.min(paraCount, 60) * 3;             // 段落是正文最硬的信号
  score += Math.min(Math.floor(textLen / 100), 60); // 长度
  score += Math.min(commaCount, 30);                // 叙述文字逗号多
  score += cls.score;
  if (tag === 'article' || tag === 'main') score += 15;        // 语义标签自带信号
  else if (tag === 'section') score += 10;
  score -= Math.round(linkDensity * 120);           // 导航块链接密度接近 1
  if (textLen < 60) score -= 25;                    // 太短不像正文
  else if (textLen < 140) score -= 10;
  if (paraCount === 0) score -= 10;
  if (cls.rejected) score = Math.min(score, -5);    // 负面词直接淘汰

  return {
    score,
    rejected: cls.rejected,
    details: {
      tag,
      cls: (attrValue(attrs, 'class') || attrValue(attrs, 'id') || '').slice(0, 60),
      textLen, ownTextLen: textLen, paraCount, commaCount,
      linkDensity: Math.round(linkDensity * 100) / 100,
      keywords: cls.hits,
    },
  };
}

/**
 * 给一条候选打分。`nested` 是**严格嵌套在它内部**的其他候选的范围（相对 fragment 坐标）。
 *
 * 排他评分：把这些嵌套块整段剪掉再数文本/段落/链接——body / layout 这类聚合容器
 * 自身几乎不携带文本，不会靠把正文与噪音一起吞进来刷分；它的"自己名下"只剩
 * 真正属于它的内容（侧栏噪音、页脚）。
 */
function scoreCandidate(clean, cand, nested = []) {
  const full = clean.slice(cand.innerStart, cand.innerEnd);
  const cuts = [...nested].sort((a, b) => a.start - b.start);
  let own = '';
  let cursor = 0;
  for (const cut of cuts) {
    const s = Math.max(0, cut.start);
    const e = Math.min(full.length, cut.end);
    if (e <= s) continue;
    own += full.slice(cursor, s);
    cursor = Math.max(cursor, e);
  }
  own += full.slice(cursor);
  return scoreFragment(own, cand.tag, cand.attrs);
}

/** 回退：把所有"像正文"的 <p> 完整块串起来（垃圾页兜底）。
 *  会先剔除负面容器（class 带 comment/promo/ads… 的 div 等）里的段落——
 *  兜底救"没有正文"的页面，不能反过来把推广文案当成正文。 */
function fallbackParagraphs(clean, minChars = 40) {
  const negativeZones = [];
  const zoneRe = /<(?:div|section|td|li)\b[^>]*>/gi;
  const openTags = [];
  let zm;
  // 粗粒度划出"负面容器"的字符范围：class/id 命中负面词的容器，从开标签到配对闭标签。
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack = [];
  while ((zm = tagRe.exec(clean)) !== null) {
    const isClose = zm[1] === '/';
    const tag = zm[2].toLowerCase();
    if (isClose) {
      const idx = stack.map((s) => s.tag).lastIndexOf(tag);
      if (idx >= 0) {
        const open = stack.splice(idx)[0];
        if (open && open.negative) negativeZones.push([open.start, zm.index + zm[0].length]);
      }
      continue;
    }
    if (VOID_TAGS.has(tag)) continue;
    const attrs = zm[3] || '';
    const cls = `${attrValue(attrs, 'class')} ${attrValue(attrs, 'id')}`.toLowerCase();
    const negative = NEGATIVE_KEYWORDS.some((w) => cls.includes(w));
    stack.push({ tag, start: zm.index, negative });
  }
  const inNegative = (pos) => negativeZones.some(([s, e]) => pos >= s && pos < e);

  const out = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (inNegative(m.index)) continue;
    const t = textOf(m[1]);
    if (t.length >= minChars) out.push(`<p>${m[1]}</p>`);
  }
  return out.join('\n');
}

/**
 * 主入口：给一段完整 HTML，返回正文信息。
 * @returns {{ ok:boolean, reason?:string, title:string, html:string, markdown?:undefined,
 *              picked?:object, debug?:object[] }}
 */
function extractArticle(rawHtml, options = {}) {
  const minParaChars = options.minParaChars || 40;
  const { html: clean, title } = preClean(rawHtml);
  if (!clean.trim()) return { ok: false, reason: '页面没有可解析的内容', title: '', html: '' };

  const candidates = findCandidates(clean);

  // 每个候选先算"严格包含"的嵌套候选，再做排他评分（聚合容器不靠吞并刷分）。
  const scored = candidates.map((cand) => ({ cand, ...scoreCandidate(clean, cand, []) }));
  for (const outer of scored) {
    const nested = scored
      .filter((other) => other !== outer
        && outer.cand.start <= other.cand.start && outer.cand.end >= other.cand.end
        && (outer.cand.end - outer.cand.start) > (other.cand.end - other.cand.start))
      .map((other) => ({
        start: Math.max(0, other.cand.start - outer.cand.innerStart),
        end: Math.min(outer.cand.innerEnd, other.cand.end) - outer.cand.innerStart,
      }));
    const own = scoreCandidate(clean, outer.cand, nested);
    outer.score = own.score;
    outer.rejected = own.rejected;
    Object.assign(outer.details, own.details);
  }

  // 同键分组合并：正文常被拆成几个并列的兄弟块（章节分页、多页文章）。
  // 单独每块都可能过不了线，所以**组**要一起评：key = 标签|class，
  // 同 key 且互不嵌套的候选合并成一个"虚拟块"重新打分，分数记给整组。
  // 负面 class（ad-box / promo…）整组直接淘汰——推广位重复多少次都是推广位。
  const groups = new Map();
  for (const s of scored) {
    if (s.rejected) continue;
    const key = `${s.cand.tag}|${s.details.cls}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // 互不嵌套才合并（嵌套的已经在排他评分里处理过了）。
    const roots = members.filter((m) => !members.some((o) => o !== m
      && o.cand.start <= m.cand.start && o.cand.end >= m.cand.end));
    if (roots.length < 2) continue;
    const sorted = [...roots].sort((a, b) => a.cand.start - b.cand.start);
    const merged = sorted.map((m) => clean.slice(m.cand.innerStart, m.cand.innerEnd)).join('\n');
    const attrs = sorted[0].cand.attrs;
    const group = scoreFragment(merged, sorted[0].cand.tag, attrs);
    if (group.score > 0 && !group.rejected) {
      const entry = {
        cand: {
          tag: sorted[0].cand.tag,
          attrs,
          start: sorted[0].cand.start,
          end: sorted[sorted.length - 1].cand.end,
          innerStart: sorted[0].cand.innerStart,
          innerEnd: sorted[sorted.length - 1].cand.innerEnd,
          merged: sorted.map((m) => m.cand),
        },
        score: group.score,
        rejected: false,
        details: { ...group.details, cls: `${group.details.cls} (+${sorted.length - 1} 个同名块)` },
      };
      scored.push(entry);
    }
  }

  const positives = scored.filter((s) => s.score > 0 && !s.rejected);
  // 排序：分数高者胜；并列取文档位置更靠前的（外层聚合更稳）。
  positives.sort((a, b) => (b.score - a.score) || (a.cand.start - b.cand.start));

  // 空壳容器下沉：最高分容器的正文如果全靠嵌套块撑着（自己几乎没有文本），
  // 就选那个真正装着正文的块。聚合正文（自己有文本的 main/section）不下沉。
  let best = positives[0] || null;
  if (best) {
    for (;;) {
      if (best.cand.merged) break; // 合并组已经是"叶子们"的并集，不再下沉
      const children = positives.filter((p) => !p.cand.merged && p !== best
        && best.cand.start <= p.cand.start && best.cand.end >= p.cand.end
        && (best.cand.end - best.cand.start) > (p.cand.end - p.cand.start));
      if (!children.length) break;
      if (best.details.ownTextLen > 80) break;
      children.sort((a, b) => (b.score - a.score) || (a.cand.start - b.cand.start));
      best = children[0];
    }
  }

  // 输出：合并组把成员块拼接；普通候选取内部。
  let htmlOut = '';
  if (best) {
    htmlOut = best.cand.merged
      ? best.cand.merged.map((m) => clean.slice(m.innerStart, m.innerEnd)).join('\n')
      : clean.slice(best.cand.innerStart, best.cand.innerEnd);
  }

  const debug = positives.slice(0, 5).map((s) => ({ ...s.details, score: s.score }));

  if (best) {
    const inner = htmlOut;
    const h1 = inner.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
    return {
      ok: true,
      title: title || (h1 ? textOf(h1[1]) : ''),
      html: inner,
      picked: { ...best.details, score: best.score },
      debug,
    };
  }

  // 全军覆没：段落合并兜底。
  const joined = fallbackParagraphs(clean, minParaChars);
  if (joined) {
    return {
      ok: true,
      title,
      html: joined,
      picked: { tag: 'p', cls: '(段落合并兜底)', score: 0 },
      debug,
    };
  }
  return { ok: false, reason: '没有找到像正文的块（页面可能全是导航或广告）', title, html: '', debug };
}

// 导出给同文档其它脚本（panel.html 经典 script 共享全局作用域）。
const ScraperExtract = {
  extractArticle, preClean, findCandidates, scoreCandidate,
  fallbackParagraphs, stripTags, textOf, decodeEntities, attrValue,
  POSITIVE_KEYWORDS, NEGATIVE_KEYWORDS, STRIP_TAGS, NOISE_CONTAINERS, VOID_TAGS,
};
