// lib/qa.js —— ask_kb：检索 → 注入 Prompt → 记忆核心作答
//
// Prompt 形状（上下文注入的边界要清楚）：
//
//   请根据以下本地文档回答用户：
//   [切片 1｜文档 X 第 3 片｜相关度 87] …正文…
//   [切片 2｜…] …
//
//   用户的问题：……
//
// 三条纪律：
//   1. 相关度低于 minScore → 不问模型，直接回答"文档里没查到"（硬编比幻觉便宜）；
//   2. 注入的切片总量受 3500 字预算管（llm.chat 的 text 上限 4000，留缓冲）；
//   3. 会话固定 kb-qa 角色：文档问答的往来单独放一份记忆。

'use strict';

const MEMCORE_TARGET = 'com.shixiansi.plugin-memcore';
const KB_ROLE = 'kb-qa';
const CONTEXT_BUDGET = 3500;

/** ask_kb 入参清洗：question 必填。 */
function cleanAskPayload(payload) {
  const question = text(payload && (payload.question ?? payload.q), 1000).trim();
  if (!question) throw new Error('ask_kb 需要 question：要问的问题');
  return { question };
}

/** 检索结果 → 注入块（含出处与相关度；总量受预算管）。 */
function buildContext(hits, budget) {
  const blocks = [];
  let used = 0;
  for (const hit of hits) {
    const header = `[切片｜文档 ${hit.docId} 第 ${hit.seq} 片｜相关度 ${hit.score}]`;
    const block = `${header}\n${hit.text}`;
    if (used + block.length > budget) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join('\n\n');
}

const KB_SYSTEM = [
  '你是用户的桌宠。回答问题时**以提供的本地文档切片为准**：切片里有的就据实回答，',
  '切片里没有的就明说「文档里没提到」，不要编造。回答用中文、口语化、尽量短。',
  '引用了切片内容时，在句尾标注（文档 X 第 N 片）方便主人核对。',
].join('\n');

/** 带上下文问记忆核心。 */
async function askModel(prompt) {
  const out = await request('plugin.call', {
    target: MEMCORE_TARGET,
    method: 'chat',
    payload: { roleId: KB_ROLE, userId: 'desktop', userName: '主人', text: prompt, hint: '这是知识库问答请求：以注入的文档切片为准作答' },
  });
  const reply = out && typeof out.text === 'string' ? out.text : '';
  if (!reply.trim()) throw new Error('记忆核心没有返回内容（检查它的模型配置）');
  return reply;
}

/**
 * `ask_kb` 方法本体（面板提问走同一条 answerQuestion）。
 *
 * @param {object} payload {question}
 * @returns {Promise<object>} {answer, hits: [{docId, seq, score}], usedContext}
 */
async function handleAskKb(payload) {
  await refreshConfig();
  const { question } = cleanAskPayload(payload);
  const topK = num('topK', 1, 5, 3);
  const minScore = num('minScore', 0, 100, 20);

  const hits = await search(question, topK);
  const useful = hits.filter((h) => h.score >= minScore);
  if (!useful.length) {
    return {
      answer: '文档里没查到相关内容。可以把更多文档加进知识库，或换个问法。',
      hits: hits.map((h) => ({ docId: h.docId, seq: h.seq, score: h.score })),
      usedContext: false,
    };
  }

  const context = buildContext(useful, CONTEXT_BUDGET);
  const prompt = [
    '请根据以下本地文档回答用户：',
    context,
    '',
    `用户的问题：${question}`,
  ].join('\n');

  const answer = await askModel(prompt);
  return {
    answer,
    hits: useful.map((h) => ({ docId: h.docId, seq: h.seq, score: h.score })),
    usedContext: true,
  };
}

// --- 文档管理 ---------------------------------------------------------------------

/** 文档列表（storage 只读）。 */
async function listDocuments() {
  const index = await readJSON('kb/docs/index', []);
  return Array.isArray(index) ? index : [];
}

/** 添加一份文档：清洗 → 切片 → 建索引 → 记入列表。 */
async function addDocument({ title, content }) {
  await refreshConfig();
  const cleanTitle = text(String(title || '').trim() || '未命名文档', 60);
  const body = stripMarkdownNoise(content);
  if (!body.trim()) throw new Error('文档内容是空的');
  if (body.length > 400000) throw new Error('文档太长（≤40 万字符）：请拆成几份再入库');

  const docId = makeDocId(cleanTitle);
  const params = { chunkChars: num('chunkChars', 200, 1000, 500), chunkOverlap: num('chunkOverlap', 0, 200, 50) };
  const chunks = chunkDocument(body, params, docId);
  if (!chunks.length) throw new Error('文档清洗后没有可索引的内容');

  await writeJSON(docKey(docId), { docId, title: cleanTitle, addedAt: now(), chars: body.length, chunkCount: chunks.length });
  const meta = await indexDocument(docId, chunks);

  const list = await listDocuments();
  await writeJSON('kb/docs/index', list.concat([{ docId, title: cleanTitle, addedAt: now(), chunkCount: chunks.length }]));

  return { docId, title: cleanTitle, chunkCount: chunks.length, indexMeta: meta };
}

/** 删除一份文档：索引、正文、列表一起删。 */
async function removeDocument(docId) {
  await removeDocumentFromIndex(docId);
  await request('storage.remove', { key: docKey(docId) }).catch(() => {});
  const list = await listDocuments();
  await writeJSON('kb/docs/index', list.filter((d) => d.docId !== docId));
}

/** 从配置里的 URL 抓一份远程文档（Markdown/TXT）并入库。 */
async function fetchRemoteDocuments() {
  await refreshConfig();
  const urls = String(cfg.docUrls || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const url of urls.slice(0, 8)) {
    try {
      const out = await request('net.fetch', { url, method: 'GET' });
      const body = out && typeof out.body === 'string' ? out.body : '';
      if (!body.trim()) throw new Error('空内容');
      if (out && out.truncated) throw new Error('内容超过 8 MiB 被截断');
      const title = decodeURIComponent(url.split('/').pop() || '远程文档').replace(/\.(md|txt|markdown)$/i, '');
      const added = await addDocument({ title, content: body });
      results.push({ url, ok: true, docId: added.docId, chunkCount: added.chunkCount });
    } catch (err) {
      results.push({ url, ok: false, error: text(err && err.message ? err.message : err, 120) });
    }
  }
  return results;
}
