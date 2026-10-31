// lib/chunker.js —— 滑动窗口切片：500 字左右、50 字重叠
//
// WHY 重叠：切片边界是按字数切的，一个句子跨过边界就被拦腰斩断——两半各自都读不通。
// 重叠让相邻切片共享最后/最开的几十个字：边界处的语义至少在一个切片里是完整的。
//
// 切在**句子边界**优先：先按大小切出窗口，再把窗口的结尾往前找最近的句末标点
// （。！？；\n）——只有当"回退到句末"不会把切片砍掉超过 40% 时才回退
// （防止一个 500 字的窗口因为只有一个句号而缩成 100 字）。
//
// 元数据：每个切片带 {docId, seq, text}——检索命中的切片要能指回"哪份文档第几片"。

'use strict';

/** 切片入参清洗。 */
function cleanChunkParams({ chunkChars, chunkOverlap } = {}) {
  const size = Number.isFinite(chunkChars) ? clampInt(chunkChars, 200, 1000, 500) : 500;
  const overlap = Number.isFinite(chunkOverlap) ? clampInt(chunkOverlap, 0, 200, 50) : 50;
  // 重叠必须小于切片大小（否则窗口不前进，死循环）。
  return { size, overlap: Math.min(overlap, Math.floor(size / 2) - 1) };
}

/** 轻度清洗 Markdown：去代码围栏标记与图片语法，保留正文与标题的**文字**。 */
function stripMarkdownNoise(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z]*\n?/g, '')) // 保留代码内容本身
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                                  // 图片：没有文字价值
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                               // 链接：保留文字
    .replace(/^#{1,6}\s+/gm, '');                                          // 标题井号：保留文字
}

const SENTENCE_END = /[。！？；!?;\n]/;

/** 在 [start, min(start+size, len)) 里找最后一个句末位置（返回**含**该字符的结束下标）。 */
function lastSentenceEnd(text, start, size) {
  const end = Math.min(start + size, text.length);
  for (let i = end - 1; i > start + Math.floor(size * 0.6); i -= 1) {
    if (SENTENCE_END.test(text[i])) return i + 1;
  }
  return end;
}

/**
 * 把一份长文档切成带重叠的窗口。
 *
 * @param {string} docText 文档全文（已清洗）
 * @param {object} params {chunkChars?, chunkOverlap?}
 * @param {string} docId 文档 id（进每个切片的元数据）
 * @returns {Array<{docId, seq, text}>}
 */
function chunkDocument(docText, params, docId) {
  const { size, overlap } = cleanChunkParams(params);
  const text = String(docText || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return [];

  const chunks = [];
  let start = 0;
  let seq = 0;
  while (start < text.length) {
    let end = lastSentenceEnd(text, start, size);
    // 最后一片：剩余不足一片就整体收尾。
    if (end >= text.length) end = text.length;
    const piece = text.slice(start, end).trim();
    if (piece) {
      chunks.push({ docId, seq: seq += 1, text: piece });
    }
    if (end >= text.length) break;
    // 下一窗口从"本窗口结尾 − 重叠"开始；至少前进 1 字（重叠 < size 已由清洗保证）。
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** 一份文档的存储键。 */
function docKey(docId) {
  return `kb/docs/${String(docId || '').replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** 文档 id：标题 slug + 短随机后缀（重名不冲突）。中文保留——storage 键的清洗由 docKey 做。 */
function makeDocId(title) {
  const slug = String(title || 'doc').replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 40) || 'doc';
  return `${slug}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}
