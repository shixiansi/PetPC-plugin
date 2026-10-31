// lib/scrape.js —— 抓取编排：URL 规范化 → net.fetch → 提取 → turndown → 入库
//
// 这是插件的业务主链路。编排层只管"顺序与失败语义"，具体每一步都在别的文件里：
//
//   net.fetch（宿主桥，白名单域名） → extract.extractArticle（评分选正文）
//   → tomd.createConverter().toMarkdown（转 Markdown） → library.libSaveArticle（入库）
//
// 进度通过 onStep 回调抛给面板（0..1 加 progress 文案），UI 不参与任何业务判断。

'use strict';

const SCRAPE_DEFAULTS = {
  timeoutMs: 30000,
  maxChars: 400000, // 超过这个长度不进评分器（8MiB 是宿主上限，正文很少超过它）
};

/** 校验并规范化 URL。返回 {ok, url, host} 或 {ok:false, reason}。 */
function scrapeNormalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: '请输入网址' };
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, reason: `不是一个能解析的网址：${raw.slice(0, 80)}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `只支持 http(s)，收到 ${u.protocol}` };
  }
  u.hash = '';
  return { ok: true, url: u.href, host: u.host };
}

/**
 * 抓一页并转 Markdown。
 * @param {object} deps 依赖注入：{request, extractor, toMarkdown, store, now}
 *   request(method, payload) —— 宿主桥；
 *   extractor(html) —— extract.extractArticle；
 *   toMarkdown(html, {baseUrl}) —— turndown 封装；
 *   store —— libCreateStore 的产物；
 *   now() —— 时间源。
 * @param {object} opts {url, onStep}
 * @returns {Promise<{page, replaced, index}>}
 */
async function scrapeRun(deps, opts) {
  const { request, extractor, toMarkdown, store } = deps;
  if (typeof request !== 'function') throw new Error('scrapeRun 缺少 request 网关');
  const now = deps.now || (() => Date.now());
  const step = typeof opts.onStep === 'function' ? opts.onStep : () => {};

  const norm = scrapeNormalizeUrl(opts.url);
  if (!norm.ok) throw new Error(norm.reason);
  step({ phase: 'fetch', progress: 0.05, note: `正在抓取 ${norm.host} …` });

  let resp;
  try {
    resp = await request('net.fetch', {
      method: 'GET',
      url: norm.url,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0 (compatible; PetPC-WebScraper/1.0)',
      },
    });
  } catch (err) {
    throw new Error(`抓取失败：${String((err && err.message) || err)}`);
  }
  const status = Number(resp && resp.status) || 0;
  if (status < 200 || status >= 300) {
    throw new Error(`服务器返回 ${status}（只处理 2xx）`);
  }
  let body = String((resp && resp.body) || '');
  if (resp && resp.truncated) {
    step({ phase: 'fetch', progress: 0.3, note: '页面很大，已按宿主上限截断' });
  }
  if (body.length > SCRAPE_DEFAULTS.maxChars) body = body.slice(0, SCRAPE_DEFAULTS.maxChars);
  if (!body.trim()) throw new Error('页面内容是空的');

  step({ phase: 'extract', progress: 0.45, note: '解析正文 …' });
  let article;
  try {
    article = extractor(body);
  } catch (err) {
    throw new Error(`解析正文失败：${String((err && err.message) || err)}`);
  }
  if (!article || !article.ok) {
    throw new Error((article && article.reason) || '没有找到正文');
  }

  step({ phase: 'convert', progress: 0.7, note: '转换 Markdown …' });
  const markdown = toMarkdown(article.html, { baseUrl: norm.url });
  if (!markdown.trim()) throw new Error('正文转换后是空的（页面可能只有图片或脚本）');

  const page = {
    id: deps.makeId ? deps.makeId(norm.url) : ScraperLibrary.libMakeId(norm.url),
    url: norm.url,
    host: norm.host,
    title: article.title || norm.host,
    markdown,
    picked: article.picked || null,
    at: now(),
  };

  step({ phase: 'save', progress: 0.9, note: '写入文章库 …' });
  const saved = await ScraperLibrary.libSaveArticle(store, page);
  step({ phase: 'done', progress: 1, note: `完成：${page.title}（${markdown.length} 字）` });
  return { page, replaced: saved.replaced, index: saved.index };
}

const ScraperScrape = { scrapeRun, scrapeNormalizeUrl, SCRAPE_DEFAULTS };
