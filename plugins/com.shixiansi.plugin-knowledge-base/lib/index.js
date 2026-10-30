// lib/index.js —— 纯 JS 的 TF-IDF 倒排索引
//
// 结构（全部存在 storage，重启即恢复）：
//
//   kb/index/terms   { "<term>": [{ c: chunkKey, tf: 出现次数 }] }   倒排表
//   kb/index/meta    { docCount, chunkCount, terms: 词条数, builtAt }  索引进度
//
// 分词（zh + en 混合，无分词库）：连续的拉丁字母/数字为一个词（小写化），
// 中文按**双字组**（bigram）切——单字无区分度，bigram 是无分词器时性价比最高的
// 检索粒度；查询侧用同样的切法，两边对齐。
//
// 评分：TF-IDF 的标准式——查询词的 IDF × 切片内的 TF（对数化防止长文占便宜），
// 取 Top-K。

'use strict';

const KEY_TERMS = 'kb/index/terms';
const KEY_META = 'kb/index/meta';
const KEY_CHUNKS = 'kb/index/chunks'; // chunkKey → {docId, seq, text}（检索后要回读正文）

/** 分词：拉丁词 + 中文 bigram。 */
function tokenize(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  // 拉丁词。
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_'-]*/g)) {
    out.push(m[0]);
  }
  // 中文（含中日韩统一表意文字区）bigram。
  const cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

/** 一个切片的倒排条目：term → tf。 */
function termFrequencies(chunkText) {
  const tf = new Map();
  for (const term of tokenize(chunkText)) {
    tf.set(term, (tf.get(term) || 0) + 1);
  }
  return tf;
}

/** 读索引三件套。 */
async function loadIndex() {
  const [terms, meta, chunks] = await Promise.all([
    readJSON(KEY_TERMS, {}),
    readJSON(KEY_META, { docCount: 0, chunkCount: 0, terms: 0, builtAt: 0 }),
    readJSON(KEY_CHUNKS, {}),
  ]);
  return { terms, meta, chunks };
}

/** 把一份文档的切片并进索引（增量：先移除该文档旧切片，再写新的）。 */
async function indexDocument(docId, chunks) {
  await refreshConfig();
  const { terms, meta, chunks: oldChunks } = await loadIndex();

  // 1) 移除旧切片的倒排条目。
  const staleKeys = Object.keys(oldChunks).filter((k) => oldChunks[k].docId === docId);
  const stale = new Set(staleKeys);
  for (const term of Object.keys(terms)) {
    terms[term] = terms[term].filter((posting) => !stale.has(posting.c));
    if (!terms[term].length) delete terms[term];
  }
  for (const key of staleKeys) delete oldChunks[key];

  // 2) 写新切片。
  const newKeys = [];
  for (const chunk of chunks) {
    const key = `${docId}#${chunk.seq}`;
    oldChunks[key] = { docId, seq: chunk.seq, text: chunk.text };
    newKeys.push(key);
    const tf = termFrequencies(chunk.text);
    for (const [term, count] of tf) {
      if (!terms[term]) terms[term] = [];
      terms[term].push({ c: key, tf: count });
    }
  }

  // 3) 元数据。
  const docIds = new Set(Object.values(oldChunks).map((c) => c.docId));
  const next = {
    terms,
    meta: {
      docCount: docIds.size,
      chunkCount: Object.keys(oldChunks).length,
      terms: Object.keys(terms).length,
      builtAt: now(),
    },
    chunks: oldChunks,
  };
  await writeJSON(KEY_TERMS, terms);
  await writeJSON(KEY_CHUNKS, oldChunks);
  await writeJSON(KEY_META, next.meta);
  void newKeys;
  return next.meta;
}

/** 删除一份文档的索引。 */
async function removeDocumentFromIndex(docId) {
  return indexDocument(docId, []);
}

/** 查询侧分词（与文档侧同一套）。 */
function queryTerms(question) {
  return tokenize(question).slice(0, 64);
}

/**
 * 检索：返回相关度最高的 topK 个切片。
 *
 * @param {string} question 用户的问题
 * @param {number} topK
 * @returns {Promise<Array<{docId, seq, text, score}>>}
 */
async function search(question, topK) {
  const { terms, chunks } = await loadIndex();
  const k = clampInt(topK, 1, 5, 3);
  const total = Math.max(1, Object.keys(chunks).length);
  const qTerms = [...new Set(queryTerms(question))];
  if (!qTerms.length) return [];

  const scores = new Map(); // chunkKey → 分数
  for (const term of qTerms) {
    const postings = terms[term];
    if (!postings || !postings.length) continue;
    // IDF：语料里含该词的切片越少，权重越高（+1 平滑防除零）。
    const idf = Math.log((total + 1) / (postings.length + 1)) + 1;
    for (const posting of postings) {
      // TF 对数化：出现 10 次不比出现 2 次重要 5 倍。
      const tf = 1 + Math.log(posting.tf);
      scores.set(posting.c, (scores.get(posting.c) || 0) + idf * tf);
    }
  }

  // 归一成 0–100 的"相关度"（按最大分），低于 1 分的直接丢。
  const max = Math.max(0, ...scores.values());
  if (max <= 0) return [];
  const ranked = [...scores.entries()]
    .map(([key, score]) => {
      const chunk = chunks[key];
      return chunk ? { docId: chunk.docId, seq: chunk.seq, text: chunk.text, score: Math.round((score / max) * 100) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return ranked;
}
