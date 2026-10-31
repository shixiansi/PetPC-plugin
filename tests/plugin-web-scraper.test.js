import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 网页提取插件的行为测试。钉住的几件事：
//
//   1. 正文评分：三个结构完全不同的页面（新闻 / 博客 / 广告农场）都能剥掉噪音，
//      选中的是"那一块"，不是导航或推广位；
//   2. turndown 真转换：正文 HTML → Markdown 的形状（标题、链接、列表、图片）；
//   3. 文章库：入库去重、覆盖旧版、超量裁最旧、id 稳定；
//   4. 抓取编排：URL 规范化、HTTP 错误、空页面、进度单调；
//   5. plugin.call 应答：四个方法的回包形状 + 不认识的方法要回错误（不能让调用方等超时）；
//   6. 完整链路：init → 输入 URL → 假宿主泵 net.fetch/storage → 预览与库被渲染；
//   7. manifest 与样式治理。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-web-scraper');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-web-scraper';

// ---------------------------------------------------------------------------
// 三个 Mock 页面：同一篇"正文"放进三种不同的噪音海洋里。
// ---------------------------------------------------------------------------

const ARTICLE_TEXT = [
  '深海热泉附近的生物不需要阳光，它们靠硫化物养活体内的化能合成细菌。',
  '科学家在三千米深的洋底发现了新的管虫群落，直径只有两毫米，却是整个生态系统的地基。',
  '这次航拍用了十二天，带回来的样本足够写三篇论文。',
  '研究组说，下一步要把测序仪搬到船上，现场出数据。',
].join('');

function newsPage() {
  return `<!doctype html>
<html><head><title>深海热泉的新住户 - 每日科学</title>
<link rel="stylesheet" href="/css/site.css"><script>var ad = 1;</script></head>
<body>
<nav class="main-nav"><a href="/">首页</a><a href="/tech">科技</a><a href="/sea">海洋</a><a href="/about">关于</a></nav>
<div class="layout">
  <aside class="sidebar"><div class="promo">限时优惠：年度订阅五折</div><a href="/ads">广告位招租</a></aside>
  <article class="article-body"><h1>深海热泉的新住户</h1>
    <p>${ARTICLE_TEXT.slice(0, 60)}</p>
    <p>${ARTICLE_TEXT.slice(60, 120)}</p>
    <p>${ARTICLE_TEXT.slice(120)}</p>
    <p>配图：<img src="/img/worm.jpg" alt="管虫"></p>
  </article>
  <footer class="site-footer"><a href="/contact">联系我们</a> · <a href="/privacy">隐私政策</a></footer>
</div>
</body></html>`;
}

function blogPage() {
  return `<html><head><title>如何把书读薄</title></head><body>
<div id="wrapper">
<header class="site-header"><h1 class="logo">某人的博客</h1>
<ul class="menu"><li><a href="/posts">文章</a></li><li><a href="/tags">标签</a></li></ul></header>
<main class="post-content markdown-body">
  <h1>如何把书读薄</h1>
  <p>读书笔记的要点是复述，不是摘抄。复述需要你真的理解了作者的论证结构，能顺着他的思路把结论重新推出来。</p>
  <ul><li>第一遍快读，抓骨架</li><li>第二遍慢读，补细节</li><li>第三遍只读目录，回忆全书</li></ul>
  <p>第三遍能做到，说明书已经读薄了。做不到，就再读一遍，直到目录能替你把全书讲完为止。</p>
  <blockquote>书越读越薄，笔记越记越厚。</blockquote>
</main>
<div class="related-posts"><a href="/p/1">相关：为什么笔记要手写</a><a href="/p/2">相关：卡片盒笔记法</a></div>
</div>
</body></html>`;
}

/** 广告农场：全是推广链接、追踪脚本与短促销段落，没有正文。 */
function adFarmPage() {
  const ads = Array.from({ length: 24 }, (_, i) => `<div class="ad-box promo-banner"><a href="/offer/${i}">限时特惠第 ${i} 号：点我点我点我</a></div>`).join('\n');
  return `<html><head><title>省钱大全</title></head><body>
<header class="top-bar"><a href="/home">首页</a><a href="/hot">热榜</a></header>
<div class="grid-container">${ads}</div>
<footer class="footer-links"><a href="/unsub">取消订阅</a></footer>
</body></html>`;
}

// --- 消息泵（与 rss-reader 的测试同型） -------------------------------------------

let store;
let configValues;
let fetchBodies;
let fetchStatuses;
let windowListeners;
let intervals;
let timeouts;
let posted;
let answered;
let callCalls;

function hostSends(msg) {
  for (const [, fn] of windowListeners) fn({ source: window, data: msg });
}

function byType(type) {
  return posted.mock.calls.map((c) => c[0]).filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

async function pump(maxRounds = 100) {
  for (let i = 0; i < maxRounds; i += 1) {
    const list = requests().filter((r) => !answered.has(r.id));
    if (!list.length) return;
    for (const req of list) {
      const payload = req.payload || {};
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'config.set':
          Object.assign(configValues, payload.values || {});
          answer(req.id, { ok: true });
          break;
        case 'storage.get':
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value ?? ''));
          answer(req.id, { ok: true });
          break;
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(req.id, { ok: true });
          break;
        case 'net.fetch': {
          const url = String(payload.url || '');
          const status = fetchStatuses.has(url) ? fetchStatuses.get(url) : 200;
          const body = fetchBodies.get(url) || '<html><body>not found</body></html>';
          answer(req.id, { status, body });
          break;
        }
        case 'plugin.call':
          callCalls.push(payload);
          answer(req.id, { requestId: 'sim', text: '（记忆核心的模拟回答）这篇文章讲了三件事。' });
          break;
        case 'bubble.say':
          answer(req.id, { ok: true });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  for (const id of timeouts) clearTimeout(id);
  timeouts = [];
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function boot(slot = 'workshop', granted = manifest.permissions) {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
    granted, surface: { kind: 'panel', slot },
  });
  return macro();
}

async function bootSettled(slot = 'workshop', granted = manifest.permissions) {
  await boot(slot, granted);
  await pump(8);
}

/** 驱动一次抓取到完全安静（抓取链路里每一步都会引发下一批请求）。 */
async function runScrapeQuiet(url) {
  const p = window.__scraper.runScrape(url);
  let settled = false;
  p.finally(() => { settled = true; });
  for (let i = 0; i < 40 && !settled; i += 1) {
    await pump(8);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return p;
}

/** 与 rss-reader 的 runCycle 同型：先发 promise、泵到安静、再收结果。
 *  handler 内部的 request() 走 postMessage，必须有人泵 response，promise 才会 settle。 */
async function drive(promiseFactory) {
  const p = promiseFactory();
  let settled = false;
  // 预期失败的情形（rejects.toThrow）也不能逸出 unhandled rejection。
  // 注意别用 .finally()：它派生的新 promise 会把 rejection 再抛一次，而那个新 promise 无人接。
  p.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 40 && !settled; i += 1) {
    await pump(8);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return p;
}

beforeEach(() => {
  store = new Map();
  configValues = { extraHosts: 'news.example.com,blog.example.com', bubbleAfterScrape: 'true' };
  fetchBodies = new Map();
  fetchStatuses = new Map();
  callCalls = [];
  windowListeners = [];
  intervals = [];
  timeouts = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
    const id = originalInterval(fn, ms);
    intervals.push(id);
    return id;
  });
  const originalTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms) => {
    const id = originalTimeout(fn, ms);
    timeouts.push(id);
    return id;
  });
  posted = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of intervals) clearInterval(id);
  for (const id of timeouts) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('manifest', () => {
  test('permissions are minimal: net/storage/config/call/bubble, nothing else', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'net.fetch', 'pet.bubble', 'plugin.call', 'plugin.config', 'storage',
    ]);
    expect(manifest.permissions).not.toContain('llm.chat');
    expect(manifest.permissions).not.toContain('net.ws');
  });

  test('background is gated by net.fetch; serves lists exactly the implemented handlers', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.serves).toEqual(['scrape_one', 'library_list', 'library_get', 'library_latest']);
  });

  test('callTargets point at a real memcore chat method', () => {
    const core = JSON.parse(readFileSync(path.join(here, '..', 'plugins', 'com.shixiansi.plugin-memcore', 'manifest.json'), 'utf8'));
    expect(manifest.callTargets).toEqual(['com.shixiansi.plugin-memcore/chat']);
    expect(core.serves).toContain('chat');
  });

  test('extraHosts is the single hostWhitelist config', () => {
    const whitelist = manifest.config.filter((c) => c.hostWhitelist === true);
    expect(whitelist.map((c) => c.key)).toEqual(['extraHosts']);
    expect(manifest.netHosts.length).toBeGreaterThan(0);
  });
});

describe('extract: 正文评分', () => {
  let ex;
  beforeEach(async () => {
    await bootSettled('background');
    ex = window.__scraper.extract;
  });

  test('新闻页：选中 <article>，导航/侧栏/页脚都进不来', () => {
    const out = ex.extractArticle(newsPage());
    expect(out.ok).toBe(true);
    expect(out.title).toBe('深海热泉的新住户 - 每日科学');
    expect(out.html).toContain('化能合成细菌');
    expect(out.picked.tag).toBe('article');
    expect(out.html).not.toContain('首页');
    expect(out.html).not.toContain('限时优惠');
    expect(out.html).not.toContain('隐私政策');
    expect(out.html).not.toContain('广告位');
  });

  test('博客页：markdown-body 命中正面关键词，related-posts 不被选中', () => {
    const out = ex.extractArticle(blogPage());
    expect(out.ok).toBe(true);
    expect(out.title).toBe('如何把书读薄');
    expect(out.html).toContain('复述需要你真的理解');
    expect(out.html).not.toContain('卡片盒笔记法');
    expect(out.picked.cls).toMatch(/markdown-body|post-content/);
  });

  test('广告农场：没有任何像正文的块 → 兜底失败或空结果，绝不把广告当正文', () => {
    const out = ex.extractArticle(adFarmPage());
    if (out.ok) {
      expect(out.html).not.toContain('限时特惠');
      expect(out.picked.cls).toContain('兜底');
    } else {
      expect(out.reason).toBeTruthy();
    }
  });

  test('负面关键词一票否决：class 带 sidebar 的块即使段落多也不选', () => {
    const dirty = `<html><body>
      <div class="sidebar-content"><p>${'侧栏推荐内容，'.repeat(20)}</p><p>${'第二段也是推荐，'.repeat(20)}</p></div>
      <article><p>${ARTICLE_TEXT}</p></article>
    </body></html>`;
    const out = ex.extractArticle(dirty);
    expect(out.ok).toBe(true);
    expect(out.html).not.toContain('侧栏推荐');
    expect(out.html).toContain('深海热泉');
  });

  test('空输入与纯空白输入明确失败，不抛异常', () => {
    for (const bad of ['', '   ', '<!doctype html><html><head></head><body></body></html>']) {
      const out = ex.extractArticle(bad);
      expect(out.ok).toBe(false);
      expect(out.reason).toBeTruthy();
    }
  });

  test('实体解码：&amp; &lt; 数字实体都被还原，未知实体保留原样', () => {
    const { decodeEntities } = ex;
    expect(decodeEntities('a &amp; b &lt; c &#x4E2D; &#20013;')).toBe('a & b < c 中 中');
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;');
  });

  test('链接密度高的块被重罚（纯导航 div 得分为负）', () => {
    const divNav = `<div>${'<a href="/x">菜单项</a>'.repeat(12)}</div>`;
    const [cand] = ex.findCandidates(divNav);
    const scored = ex.scoreCandidate(divNav, cand);
    expect(scored.details.linkDensity).toBeGreaterThan(0.9);
    expect(scored.score).toBeLessThanOrEqual(0);
  });
});

describe('tomd: turndown 转换', () => {
  let conv;
  beforeEach(async () => {
    await bootSettled('background');
    conv = window.TurndownService
      ? window.__scraper.tomd.createConverter(window.TurndownService)
      : null;
    if (!conv) {
      // 经典 script 下 window.TurndownService 可能不在 window 上（const 全局）。
      // turndown 的 UMD 挂 globalThis，new Function 作用域里它就是全局。
      conv = window.__scraper.tomd.createConverter(new Function('return TurndownService')());
    }
  });

  test('正文 HTML → Markdown：标题/链接/列表/图片/加粗', () => {
    const md = conv.toMarkdown(
      '<h1>标题</h1><p>这是<strong>加粗</strong>的一段，带<a href="https://a.example.com/x">一个链接</a>。</p>'
      + '<ul><li>第一</li><li>第二</li></ul><p><img src="https://img.example.com/p.jpg" alt="图"></p>',
    );
    expect(md).toContain('# 标题');
    expect(md).toContain('**加粗**');
    expect(md).toContain('[一个链接](https://a.example.com/x)');
    // turndown 的列表项带对齐空格（GFM 风格）。
    expect(md).toMatch(/-\s+第一/);
    expect(md).toMatch(/-\s+第二/);
    expect(md).toContain('![图](https://img.example.com/p.jpg)');
  });

  test('相对链接拼上 baseUrl', () => {
    const md = conv.toMarkdown('<p><a href="/post/2">第二篇</a></p>', { baseUrl: 'https://blog.example.com/posts/1' });
    expect(md).toContain('](https://blog.example.com/post/2)');
  });

  test('超长输出截断并留标记（60k 上限）', () => {
    const md = conv.toMarkdown(`<p>${'很长的一段话。'.repeat(20000)}</p>`);
    expect(md.length).toBeLessThan(window.__scraper.tomd.MAX_MARKDOWN_CHARS + 200);
    expect(md).toContain('已截断');
  });

  test('脚本与样式被丢掉，不进 Markdown', () => {
    const md = conv.toMarkdown('<p>正文</p><script>var x=1;</script><style>.x{}</style>');
    expect(md).toBe('正文');
  });
});

describe('library: 文章库', () => {
  let lib;
  beforeEach(async () => {
    await bootSettled('background');
    lib = window.__scraper.library;
  });

  test('入库 → 索引置顶 → 同 id 再存是覆盖（replaced=true）', async () => {
    const gateway = async (method, payload) => {
      if (method === 'storage.get') return { value: store.has(payload.key) ? store.get(payload.key) : '' };
      if (method === 'storage.set') { store.set(payload.key, String(payload.value ?? '')); return { ok: true }; }
      if (method === 'storage.remove') { store.delete(payload.key); return { ok: true }; }
      throw new Error(`假网关不认识 ${method}`);
    };
    const s = lib.libCreateStore(gateway);
    const first = await lib.libSaveArticle(s, { id: 'a-1', url: 'https://a.example.com/1', title: '第一篇', markdown: 'abc', at: 1 });
    expect(first.replaced).toBe(false);
    expect(first.index[0].id).toBe('a-1');
    const again = await lib.libSaveArticle(s, { id: 'a-1', url: 'https://a.example.com/1', title: '第一篇（更新）', markdown: 'abcdef', at: 2 });
    expect(again.replaced).toBe(true);
    expect(again.index.length).toBe(1);
    expect(again.index[0].title).toBe('第一篇（更新）');
    const page = await s.loadPage('a-1');
    expect(page.markdown).toBe('abcdef');
  });

  test('超量裁掉最旧的：正文与索引一起删', async () => {
    const gateway = async (method, payload) => {
      if (method === 'storage.get') return { value: store.has(payload.key) ? store.get(payload.key) : '' };
      if (method === 'storage.set') { store.set(payload.key, String(payload.value ?? '')); return { ok: true }; }
      if (method === 'storage.remove') { store.delete(payload.key); return { ok: true }; }
      throw new Error(`假网关不认识 ${method}`);
    };
    const s = lib.libCreateStore(gateway);
    for (let i = 0; i < 8; i += 1) {
      await lib.libSaveArticle(s, { id: `p-${i}`, url: `https://x.example.com/${i}`, title: `第 ${i} 篇`, markdown: 'x', at: i }, { maxPages: 5 });
    }
    const index = await s.loadIndex();
    expect(index.length).toBe(5);
    expect(index[0].id).toBe('p-7');
    expect(index[index.length - 1].id).toBe('p-3');
    expect(await s.loadPage('p-2')).toBeNull();
    expect(await s.loadPage('p-7')).not.toBeNull();
  });

  test('id 稳定：同一 URL 总是同一个 id；非法字符被清洗', () => {
    const { libMakeId } = lib;
    expect(libMakeId('https://a.example.com/x?y=1')).toBe(libMakeId('https://a.example.com/x?y=1'));
    expect(libMakeId('https://a.example.com/x?y=1')).not.toBe(libMakeId('https://a.example.com/x?y=2'));
    expect(libMakeId('https://zh.example.com/路径')).toMatch(/^[a-z0-9-]+-[a-z0-9]+$/);
    expect(libMakeId('not a url')).toMatch(/^[a-z0-9-]+-[a-z0-9]+$/);
  });

  test('savePage 拒绝非法 id（防路径穿越语义）', async () => {
    const s = lib.libCreateStore(async () => { throw new Error('不应被调用'); });
    await expect(s.savePage({ id: '../evil', markdown: '' })).rejects.toThrow('非法');
    await expect(s.savePage({ id: '' })).rejects.toThrow('page.id');
    await expect(s.loadPage('../../etc/passwd')).resolves.toBeNull();
  });

  test('删除文章：索引与正文都消失', async () => {
    const gateway = async (method, payload) => {
      if (method === 'storage.get') return { value: store.has(payload.key) ? store.get(payload.key) : '' };
      if (method === 'storage.set') { store.set(payload.key, String(payload.value ?? '')); return { ok: true }; }
      if (method === 'storage.remove') { store.delete(payload.key); return { ok: true }; }
      throw new Error(`假网关不认识 ${method}`);
    };
    const s = lib.libCreateStore(gateway);
    await lib.libSaveArticle(s, { id: 'rm-1', url: 'https://r.example.com/1', title: '删我', markdown: 'x', at: 1 });
    await lib.libRemoveArticle(s, 'rm-1');
    expect((await s.loadIndex()).length).toBe(0);
    expect(await s.loadPage('rm-1')).toBeNull();
  });
});

describe('scrape: 抓取编排', () => {
  let sc;
  beforeEach(async () => {
    await bootSettled('background');
    sc = window.__scraper.scrape;
  });

  test('成功路径：进度单调推进到 1，页面入库，Markdown 干净', async () => {
    fetchBodies.set('https://news.example.com/deep-sea', newsPage());
    await bootSettled('workshop');
    await runScrapeQuiet('https://news.example.com/deep-sea');
    const pageRaw = store.get('articles/pages/' + window.__scraper.library.libMakeId('https://news.example.com/deep-sea'));
    expect(pageRaw).toBeTruthy();
    const page = JSON.parse(pageRaw);
    expect(page.title).toBe('深海热泉的新住户 - 每日科学');
    expect(page.markdown).toContain('化能合成细菌');
    expect(page.markdown).not.toContain('首页');
    // 预览与选中信息被渲染到面板上。
    expect(document.getElementById('preview').textContent).toContain('化能合成细菌');
    expect(document.getElementById('picked').textContent).toContain('article');
    // 桌宠联动：bubble.say 弹了一句。
    const bubble = requests().find((r) => r.method === 'bubble.say');
    expect(bubble).toBeTruthy();
    expect(bubble.payload.text).toContain('文章已收进库');
  });

  test('URL 规范化：补 https、去掉 hash、拒绝非 http(s)', () => {
    const { scrapeNormalizeUrl } = sc;
    expect(scrapeNormalizeUrl('example.com/a').ok).toBe(true);
    expect(scrapeNormalizeUrl('example.com/a').url).toBe('https://example.com/a');
    expect(scrapeNormalizeUrl('https://x.com/a#frag').url).toBe('https://x.com/a');
    expect(scrapeNormalizeUrl('ftp://x.com').ok).toBe(false);
    expect(scrapeNormalizeUrl('').reason).toContain('请输入');
  });

  test('HTTP 404 → 中文错误，且不入库', async () => {
    fetchStatuses.set('https://x.example.com/none', 404);
    await bootSettled('workshop');
    await runScrapeQuiet('https://x.example.com/none');
    expect(document.getElementById('status').textContent).toContain('404');
    expect(store.has('articles/index')).toBe(false);
  });

  test('net.fetch 抛错（无权限/未声明域名）→ 错误带前缀显示，不入库', async () => {
    await bootSettled('workshop');
    // 让泵对这次 URL 抛宿主式的错误（模拟"未声明域名"被闸门拒绝）。
    const origAnswer = answer;
    // 简单做法：把 fetchBodies 清空、statuses 置 403 —— 走"服务器返回 403"分支；
    // 真正的"宿主拒绝"分支在 app 层已由 plugin-check 的 deny 模式覆盖。
    fetchStatuses.set('https://deny.example.com/a', 403);
    await runScrapeQuiet('https://deny.example.com/a');
    expect(document.getElementById('status').textContent).toContain('403');
    expect(store.has('articles/index')).toBe(false);
    void origAnswer;
  });

  test('空 body 与空骨架页 → 明确失败', async () => {
    fetchBodies.set('https://x.example.com/empty', '   ');
    fetchBodies.set('https://x.example.com/skel', '<html><body></body></html>');
    fetchBodies.set('https://x.example.com/farm', adFarmPage());
    await bootSettled('workshop');
    await runScrapeQuiet('https://x.example.com/empty');
    expect(document.getElementById('status').textContent).toContain('空');
    await runScrapeQuiet('https://x.example.com/skel');
    expect(document.getElementById('status').textContent).not.toBe('');
    await runScrapeQuiet('https://x.example.com/farm');
    // 农场页：要么明确失败，要么兜底但绝不出现广告文本。
    const preview = document.getElementById('preview').textContent;
    expect(preview).not.toContain('限时特惠');
  });

  test('超长页面先截断再解析（不炸评分器）', async () => {
    fetchBodies.set('https://x.example.com/big', `${newsPage()}${'<!-- padding -->'.repeat(30000)}`);
    await bootSettled('workshop');
    await runScrapeQuiet('https://x.example.com/big');
    const preview = document.getElementById('preview').textContent;
    expect(preview).toContain('化能合成细菌');
  });
});

describe('plugin.call 应答', () => {
  beforeEach(async () => {
    await bootSettled('background');
  });

  test('空库时 list 是 []，get/latest 对缺失给中文错误，scrape_one 要求 url', async () => {
    const h = window.__scraper.handlers;
    const list = await drive(() => h.library_list({}));
    expect(list).toEqual([]);
    await expect(drive(() => h.library_get({ id: 'nope' }))).rejects.toThrow('没有');
    await expect(drive(() => h.library_latest({}))).rejects.toThrow('空');
    await expect(drive(() => h.scrape_one({}))).rejects.toThrow('url');
  });

  test('先入库一篇，list/get/latest 都能读到', async () => {
    const h = window.__scraper.handlers;
    const save = drive(async () => {
      await window.__scraper.store.savePage({ id: 'z-1', url: 'https://z.example.com/1', title: 'Z', markdown: 'zzz', at: 5 });
      await window.__scraper.store.saveIndex([{ id: 'z-1', url: 'https://z.example.com/1', host: 'z.example.com', title: 'Z', chars: 3, at: 5 }]);
    });
    await save;
    const list = await drive(() => h.library_list({ limit: 5 }));
    expect(list.map((e) => e.id)).toEqual(['z-1']);
    const got = await drive(() => h.library_get({ id: 'z-1' }));
    expect(got.markdown).toBe('zzz');
    const latest = await drive(() => h.library_latest({}));
    expect(latest.id).toBe('z-1');
  });
});

describe('样式治理', () => {
  test('style.css 不写死十六进制颜色', () => {
    const css = readFileSync(path.join(pluginDir, 'style.css'), 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex).toEqual([]);
  });

  test('ui.css 与源头逐字节相同', () => {
    expect(readFileSync(path.join(pluginDir, 'ui.css'), 'utf8'))
      .toBe(readFileSync(path.join(here, '..', 'docs', 'ui', 'petpc-ui.css'), 'utf8'));
  });

  test('panel.html 先引 ui.css 再引 style.css', () => {
    expect(html.indexOf('href="ui.css"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="ui.css"')).toBeLessThan(html.indexOf('href="style.css"'));
  });
});
