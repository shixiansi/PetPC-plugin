// lib/lexicon.js —— 词库：解析、索引、查词
//
// 三件事必须分开，因为它们的"为什么"完全不同：
//
//   1. `parseChunksJSONL` —— 把别人整理好的语料变成词条。它面对的是**外部格式**，所以只认
//      规范里写死的那几个标记（【词条】【释义】【例句】【详解】），别的行一律忽略：导入 1200 条
//      时，一条脏行不该让整次导入失败。
//   2. `buildIndex` —— 建索引。词条数是千级、查询是一条，所以**不需要**倒排、分词、embedding：
//      精确表 + 长度降序的模糊扫描（2000 条 × 一次 includes）在这个量级上是微秒级的事。
//      上 embedding 只会换来"要联网、要密钥、要等"——那是另一类 bug 的来源。
//   3. `lookup` —— 排序规则见下：**精确 > 词条被包含 > 词条包含查询**，同档按词条长度降序
//      （长词更具体：「电子榨菜」比「榨菜」更该被选中）。
'use strict';

/** 一条词条的规范化形状。`source` 用来在回答里说清出处（自带 / 导入）。 */
function makeEntry(raw) {
  const term = String((raw && raw.term) || '').trim();
  if (!term) return null;
  const meaning = String((raw && raw.meaning) || '').trim();
  if (!meaning) return null;
  return {
    term,
    meaning,
    detail: String((raw && raw.detail) || '').trim(),
    example: String((raw && raw.example) || '').trim(),
    source: String((raw && raw.source) || ''),
  };
}

/**
 * 解析 astrbot-rag-kb / Buzzword 的 `chunks.jsonl`。
 *
 * 每行是 `{"id":1,"text":"【词条】X\n【释义】…\n【详解】…"}`。`text` 是**给人看的连续块**，
 * 所以按标记切而不是按行切：`【详解】` 里自身可能带换行。
 *
 * 返回 `{entries, skipped}`——调用方要能告诉用户"1219 条里用上了 1183 条"，而不是静默丢数据。
 */
function parseChunksJSONL(text) {
  const entries = [];
  let skipped = 0;

  // 有的导出工具给的是**整份 JSON**（`[…]` 或 `{"chunks":[…]}`），不是一行一条。
  // 先按整份试一次：成功了就不必再逐行猜。
  const whole = String(text || '').trim();
  if (whole.startsWith('[') || whole.startsWith('{')) {
    const rows = rowsOfWholeJSON(whole);
    if (rows) {
      for (const row of rows) {
        const body = typeof (row && row.text) === 'string' ? row.text : '';
        const entry = body ? parseChunkText(body) : null;
        if (entry) entries.push(entry);
        else skipped += 1;
      }
      return { entries, skipped };
    }
  }

  for (const line of whole.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    const body = typeof (row && row.text) === 'string' ? row.text : '';
    if (!body) {
      skipped += 1;
      continue;
    }
    const entry = parseChunkText(body);
    if (entry) entries.push(entry);
    else skipped += 1;
  }
  return { entries, skipped };
}

/** 整份 JSON → 行数组；不是那种形状就返回 null。 */
function rowsOfWholeJSON(whole) {
  let parsed;
  try {
    parsed = JSON.parse(whole);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['chunks', 'data', 'items', 'entries']) {
    if (Array.isArray(parsed && parsed[key])) return parsed[key];
  }
  return null;
}

/**
 * 0 条词条时，**说清楚是什么文件**——这是"导入失败"最常见的原因，而且用户看不出来：
 * 文件夹里有两个 `.json`（`manifest.json`）和一个 `chunks.jsonl`，文件选择框默认只显示 json。
 */
function importReason(text) {
  const body = String(text || '').trim();
  if (!body) return 'empty';
  if (/"kb_name"\s*:/.test(body) && !/"text"\s*:/.test(body)) return 'manifest';
  if (!body.includes('【词条】')) {
    return body.startsWith('[') || body.startsWith('{') ? 'noMarkers' : 'notJSONL';
  }
  return 'noMarkers';
}

/** 把一段 `【词条】…【释义】…` 切成词条；没有【词条】或【释义】就返回 null。 */
function parseChunkText(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const pick = (label, next) => {
    const start = text.indexOf(`【${label}】`);
    if (start < 0) return '';
    const from = start + `【${label}】`.length;
    let to = text.length;
    for (const other of next) {
      const at = text.indexOf(`【${other}】`, from);
      if (at >= 0 && at < to) to = at;
    }
    return text.slice(from, to).trim();
  };
  const term = pick('词条', ['释义', '例句', '详解']);
  const meaning = pick('释义', ['例句', '详解']);
  if (!term || !meaning) return null;
  return makeEntry({
    term,
    meaning,
    example: pick('例句', ['详解']),
    detail: pick('详解', []),
    source: 'imported',
  });
}

/** 规范化：查词时忽略大小写与空白（「栓 Q」和「栓q」是同一个词）。 */
function normalizeTerm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、,.!?~～…"'“”‘’]/g, '');
}

/**
 * 建索引。后导入的覆盖先导入的（同一词条以最新一次导入为准），`source` 保留在词条上。
 */
function buildIndex(entryLists) {
  const byTerm = new Map();
  for (const list of entryLists || []) {
    for (const raw of list || []) {
      const entry = makeEntry(raw);
      if (!entry) continue;
      const key = normalizeTerm(entry.term);
      if (!key) continue;
      byTerm.set(key, entry);
    }
  }
  const entries = [...byTerm.values()].sort((a, b) => b.term.length - a.term.length);
  return { byTerm, entries };
}

/**
 * 查词。
 *
 * @param {{byTerm: Map<string, object>, entries: object[]}} index
 * @param {string} query   用户那句话（可以是一整句）
 * @param {{max?: number, allowPartial?: boolean}} opts
 * @returns {{entries: object[], matched: string}} `matched` 是命中的那段原文，便于回答里引用
 */
function lookup(index, query, opts) {
  const max = Math.max(1, Math.min(10, Number(opts && opts.max) || 2));
  const allowPartial = !(opts && opts.allowPartial === false);
  const raw = String(query || '').trim();
  if (!raw || !index || !index.byTerm) return { entries: [], matched: '' };
  const whole = normalizeTerm(raw);

  // ① 整句就是这个词条：最干净的一种。
  const exact = index.byTerm.get(whole);
  if (exact) return { entries: [exact], matched: exact.term };
  if (!allowPartial) return { entries: [], matched: '' };

  // ② 模糊：词条出现在句子里（「今天好破防啊」→ 破防）。`entries` 已按词条长度降序，
  //    所以长词优先；同一段文本只取前 max 条，避免"一句话里五个梗"把 prompt 撑爆。
  const hits = [];
  for (const entry of index.entries) {
    const key = normalizeTerm(entry.term);
    if (!key) continue;
    if (whole.includes(key)) hits.push(entry);
    if (hits.length >= max) break;
  }
  if (hits.length) return { entries: hits, matched: hits[0].term };

  // ③ 反方向：查询很短、词条以它开头（「显眼」→「显眼包」）。只在查询本身像"半个词"时才做，
  //    否则「我」这种单字会把半个词库捞出来。
  if (whole.length >= 2) {
    for (const entry of index.entries) {
      const key = normalizeTerm(entry.term);
      if (key.startsWith(whole)) {
        hits.push(entry);
        if (hits.length >= max) break;
      }
    }
  }
  return { entries: hits, matched: hits.length ? hits[0].term : '' };
}

/** 给模型读的一段话。空结果返回空串——调用方据此决定"什么都没查到"，不要拼一段废话进 prompt。 */
function renderHits(result) {
  const entries = (result && result.entries) || [];
  if (!entries.length) return '';
  const lines = ['【网络词·已查到】用户提到的词在本地词库里查到了，可以直接用它的意思，不要再说「不知道」：'];
  for (const entry of entries) {
    lines.push(`- ${entry.term}：${entry.meaning}`);
    if (entry.example) lines.push(`  例：${entry.example}`);
  }
  return lines.join('\n');
}

/** 测试接缝用：这些是纯函数，不碰 DOM、不碰宿主。 */
const SLANG_PURE = { parseChunksJSONL, rowsOfWholeJSON, importReason, parseChunkText, buildIndex, lookup, renderHits, normalizeTerm, makeEntry };
