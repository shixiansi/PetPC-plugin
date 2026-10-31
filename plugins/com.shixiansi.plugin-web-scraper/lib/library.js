// lib/library.js —— 本地文章库（storage 持久化 + 检索）
//
// 存储布局（插件私有目录，键每段 ≤64 且只是 A-Za-z0-9_-）：
//
//   articles/index          → 索引：[{id, url, host, title, chars, at}]（新→旧）
//   articles/pages/<id>     → 正文 JSON：{id, url, title, markdown, html, at, picked}
//
// 索引是**唯一写者**是本文件（手册 §6.3"一个键只有一个写者"）：无论 workshop 页还是
// background 帧调用 saveArticle，都经同一段代码串行写。
//
// id 的生成：host + 路径的稳定哈希。同一 URL 重复抓取**覆盖**旧正文（更新语义），
// 索引顺序提前到最新。

'use strict';

const LIB_INDEX_KEY = 'articles/index';
const LIB_PAGE_PREFIX = 'articles/pages/';
const LIB_MAX_PAGES = 100;

function libSlug(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/** 稳定的 32 位哈希（djb2 变体）——同 URL 总是同一个 id。 */
function libHash(text) {
  let h = 5381;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** 从 URL 生成文档 id：`host-路径哈希`。非法字符压成 '-'。 */
function libMakeId(url) {
  let host = 'unknown';
  let path = '';
  try {
    const u = new URL(String(url || ''));
    host = u.host;
    path = `${u.pathname}${u.search}`;
  } catch {
    path = String(url || 'unknown');
  }
  const id = `${libSlug(host).slice(0, 40)}-${libHash(path)}`;
  return id.slice(0, 64);
}

function libHostOf(url) {
  try { return new URL(String(url || '')).host || 'unknown'; } catch { return 'unknown'; }
}

/** storage 的读写都经这个注入的网关（app.js 把 request() 递进来；测试注入假网关）。 */
function libCreateStore(gateway) {
  if (typeof gateway !== 'function') throw new Error('libCreateStore 需要一个 storage 网关函数');
  async function getJson(key, fallback) {
    try {
      const out = await gateway('storage.get', { key });
      const raw = out && out.value;
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  async function setJson(key, value) {
    await gateway('storage.set', { key, value: JSON.stringify(value) });
  }
  return {
    gateway,
    async loadIndex() {
      const list = await getJson(LIB_INDEX_KEY, []);
      return Array.isArray(list) ? list : [];
    },
    async saveIndex(list) {
      await setJson(LIB_INDEX_KEY, list.slice(0, LIB_MAX_PAGES));
    },
    async loadPage(id) {
      if (!id || /[^\w-]/.test(id)) return null;
      return getJson(LIB_PAGE_PREFIX + id, null);
    },
    async savePage(page) {
      if (!page || !page.id) throw new Error('savePage 需要 page.id');
      if (/[^\w-]/.test(page.id)) throw new Error('page.id 含非法字符');
      await setJson(LIB_PAGE_PREFIX + page.id, page);
    },
    async removePage(id) {
      if (!id || /[^\w-]/.test(id)) return;
      await gateway('storage.remove', { key: LIB_PAGE_PREFIX + id }).catch(() => {});
    },
  };
}

/**
 * 保存一篇正文：覆盖同 id 旧页，索引去重置顶，超量裁掉最旧的（正文也删）。
 * @returns {Promise<{index: object[], replaced: boolean}>}
 */
async function libSaveArticle(store, page, options = {}) {
  if (!page || typeof page.id !== 'string' || !page.id) throw new Error('page.id 缺失');
  const maxPages = options.maxPages || LIB_MAX_PAGES;
  const index = await store.loadIndex();
  const replaced = index.some((e) => e.id === page.id);
  const entry = {
    id: page.id,
    url: String(page.url || ''),
    host: libHostOf(page.url),
    title: String(page.title || '(无标题)').slice(0, 120),
    chars: String(page.markdown || '').length,
    at: Number(page.at) || Date.now(),
  };
  const next = [entry, ...index.filter((e) => e.id !== page.id)];
  const keep = next.slice(0, maxPages);
  const drop = next.slice(maxPages).map((e) => e.id);
  // 先写正文再写索引：中途失败最坏情形是"正文在、索引没有"——还能靠 id 找回。
  await store.savePage(page);
  await store.saveIndex(keep);
  for (const id of drop) await store.removePage(id);
  return { index: keep, replaced, dropped: drop };
}

async function libRemoveArticle(store, id) {
  const index = await store.loadIndex();
  await store.saveIndex(index.filter((e) => e.id !== id));
  await store.removePage(id);
}

const ScraperLibrary = {
  LIB_INDEX_KEY, LIB_PAGE_PREFIX, LIB_MAX_PAGES,
  libCreateStore, libSaveArticle, libRemoveArticle,
  libMakeId, libHash, libHostOf, libSlug,
};
