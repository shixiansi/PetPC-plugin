import { describe, expect, test } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

// 市场两页（插件市场 index.html / 插件管理 manage.html）的 DOM 校验。
//
// 这两页是仓库自己的静态页，**零脚本**是一条安全承诺（index.html 的注释里写着为什么），
// 所以"UI 对不对"不能靠在浏览器里点一遍——用 jsdom 装载真实的 HTML，逐条核对设计令牌
// 与结构。两页共用的令牌文件 docs/ui/market.css 是源头，这里同时盯住三处不分叉：
//
//   1. 令牌文件本身：主色 #7C3AED、卡片圆角 18px、--sh-xs、间距 4px 倍数、46px 图标；
//   2. 每一页内联的副本与令牌文件逐字一致（手工复制必然分叉，测试代劳）；
//   3. DOM：46×46 渐变图标里是白色 SVG、卡片圆角/阴影落在 token 上、零 <script>、
//      管理页的开关/胶囊/筛选联动齐全。
//
// jsdom 没有排版引擎，:has() 选择器也不支持——"开关拨动胶囊切换"这一类断言查的是
// 静态结构（胶囊与开关同卡、id 配对、CSS 规则在行内样式表里），能自动查的就这些。

const here = path.dirname(fileURLToPath(import.meta.url));
const marketRoot = path.join(here, '..');
const tokensPath = path.join(marketRoot, 'docs', 'ui', 'market.css');
const tokens = readFileSync(tokensPath, 'utf8');

const indexHtml = readFileSync(path.join(marketRoot, 'index.html'), 'utf8');
const manageHtml = readFileSync(path.join(marketRoot, 'manage.html'), 'utf8');

/** 市场页的 <style> 内容（第一段，即令牌副本；后面的段是页面自有规则）。 */
function styleBlocks(html) {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

const MASTER_BEGIN = '/* ==== market.css (inline copy of docs/ui/market.css) ==== */';
const MASTER_END = '/* ==== end market.css copy ==== */';

/** 从页面里取出"令牌副本"那一段（两个哨兵注释之间）。 */
function inlineCopy(html) {
  const begin = html.indexOf(MASTER_BEGIN);
  const end = html.indexOf(MASTER_END);
  expect(begin, '页面里没有令牌副本的开头哨兵').toBeGreaterThan(-1);
  expect(end, '页面里没有令牌副本的结尾哨兵').toBeGreaterThan(-1);
  expect(end, '哨兵顺序不对').toBeGreaterThan(begin);
  // 副本 = 源头文件全文（含头注释），逐字一致才过关。
  const body = html.slice(begin + MASTER_BEGIN.length, end).replace(/^\n+/, '');
  const sourceBody = tokens.replace(/\n+$/, '\n');
  return { body, sourceBody };
}

/** 真实解析一份 HTML 到 jsdom。 */
function dom(html) {
  return new JSDOM(html, { url: 'https://market.local/index.html' });
}

// ---------------------------------------------------------------------------
// 1. 令牌文件本身
// ---------------------------------------------------------------------------

describe('docs/ui/market.css 设计令牌', () => {
  test('主色是 #7C3AED（violet-600），主按钮用它加深一档', () => {
    expect(tokens).toContain('--accent: #7c3aed');
    expect(tokens).toContain('--accent-strong: #6d28d9');
  });

  test('卡片圆角是 18px，且只声明在 --radius-card 一处', () => {
    expect(tokens).toContain('--radius-card: 18px');
    // 值位置上的 18px 只许出现一次（--radius-card 定义）；注释与 translateX 位移不算。
    const uses = [...tokens.matchAll(/:\s*18px/g)].length;
    expect(uses, `值位置上的 18px 出现了 ${uses} 次`).toBe(1);
  });

  test('卡片阴影默认 var(--sh-xs)，卡片规则里真的引用它', () => {
    expect(tokens).toMatch(/--sh-xs: 0 1px 2px rgba\(/);
    expect(tokens).toMatch(/\.card\s*\{[^}]*box-shadow:\s*var\(--sh-xs\)/);
  });

  test('间距全部是 4px 的倍数', () => {
    const spaces = [...tokens.matchAll(/--space-(\d):\s*(\d+)px/g)];
    expect(spaces.length).toBeGreaterThanOrEqual(7);
    for (const [, name, px] of spaces) {
      expect(Number(px) % 4, `--space-${name} 是 ${px}px，不是 4 的倍数`).toBe(0);
    }
  });

  test('图标方块 46×46，白色 SVG 由 color 提供', () => {
    expect(tokens).toContain('--icon-size: 46px');
    expect(tokens).toMatch(/\.icon\s*\{[^}]*width:\s*var\(--icon-size\)/);
    expect(tokens).toMatch(/\.icon\s*\{[^}]*height:\s*var\(--icon-size\)/);
    expect(tokens).toMatch(/\.icon\s*\{[^}]*color:\s*#ffffff/);
  });

  test('两套配色都在：浅色 :root 与深色 [data-theme="dark"]', () => {
    expect(tokens).toMatch(/:root\s*\{/);
    expect(tokens).toContain(':root[data-theme="dark"]');
  });

  test('无纯黑、动效令牌 120–320ms、transition 只引用 var(--dur)', () => {
    expect(tokens).not.toMatch(/#000\b|#000000/i);
    // 动效时长只有一个来源：--dur。它的值必须在 120–320ms 之间。
    const dur = tokens.match(/--dur:\s*(\d+)ms/);
    expect(dur, '--dur 没有定义').not.toBeNull();
    const ms = Number(dur[1]);
    expect(ms, `--dur ${ms}ms 超出 120–320`).toBeGreaterThanOrEqual(120);
    expect(ms, `--dur ${ms}ms 超出 120–320`).toBeLessThanOrEqual(320);
    // 所有 transition 都引用 var(--dur)（reduced-motion 块除外，那里是 0.01ms 开关）。
    const effective = tokens.replace(/@media \(prefers-reduced-motion[\s\S]*$/, '');
    const transitions = [...effective.matchAll(/transition:[^;]+;/g)].map((m) => m[0]);
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      expect(t, `transition 没走 --dur：${t.trim()}`).toContain('var(--dur)');
    }
    // 动画只有状态点的呼吸（keyframes pulse），没有别的 keyframes。
    expect([...tokens.matchAll(/@keyframes\s+([a-z-]+)/g)].map((m) => m[1])).toEqual(['pulse']);
  });

  test('15 个插件渐变一条不少（含三个新插件）', () => {
    for (const g of [
      'g-chat', 'g-mem', 'g-todo', 'g-pomodoro', 'g-voice', 'g-qq', 'g-qqbot',
      'g-onebot', 'g-websearch', 'g-bilibili', 'g-llmchannel', 'g-clipask',
      'g-sense', 'g-media', 'g-weather',
    ]) {
      expect(tokens).toMatch(new RegExp(`\\.${g}\\s*\\{\\s*background:\\s*linear-gradient\\(135deg,\\s*#[0-9a-f]{6},\\s*#[0-9a-f]{6}\\)`), `缺少渐变 .${g}`);
    }
  });

  test('尊重 prefers-reduced-motion', () => {
    expect(tokens).toContain('prefers-reduced-motion');
  });
});

// ---------------------------------------------------------------------------
// 2. 两页的行内副本与令牌文件一致
// ---------------------------------------------------------------------------

describe.each([
  ['index.html', () => indexHtml],
  ['manage.html', () => manageHtml],
])('%s 的令牌副本', (name, getHtml) => {
  test('与 docs/ui/market.css 逐字一致', () => {
    const { body, sourceBody } = inlineCopy(getHtml());
    expect(body, `${name} 的 market.css 副本与源头分叉了`).toBe(sourceBody);
  });
});

// ---------------------------------------------------------------------------
// 3. index.html：市场列表页
// ---------------------------------------------------------------------------

describe('index.html 市场页', () => {
  const $ = dom(indexHtml);
  const doc = $.window.document;

  test('零脚本：页面上没有 <script>，也没有外链资源', () => {
    expect(doc.querySelectorAll('script').length).toBe(0);
    const externals = [...doc.querySelectorAll('[src], link[href]')]
      .map((n) => n.getAttribute('src') || n.getAttribute('href'))
      .filter((href) => /^https?:\/\//i.test(href || ''));
    expect(externals, `发现外链：${externals.join(', ')}`).toEqual([]);
  });

  test('每个插件卡片：46×46 渐变图标 + 白色 SVG + 卡片头 + 下载按钮', () => {
    const cards = [...doc.querySelectorAll('section.card')];
    expect(cards.length).toBeGreaterThanOrEqual(13);
    let icons = 0;
    for (const card of cards) {
      const icon = card.querySelector('.icon');
      if (!icon) continue; // 「如何安装」一节没有图标
      icons += 1;
      // 渐变类落在 .icon 上
      expect(icon.className).toMatch(/\bg-[a-z]+\b/);
      // SVG 用 fill="currentColor"（色由 .icon 的白色 color 提供）
      const svg = icon.querySelector('svg');
      expect(svg, '图标里没有 SVG').not.toBeNull();
      expect(svg.getAttribute('fill')).toBe('currentColor');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    }
    expect(icons).toBe(15);
  });

  test('图标渐变类都有对应规则，没有拼错的名字', () => {
    const used = [...indexHtml.matchAll(/class="icon (g-[a-z]+)"/g)].map((m) => m[1]);
    expect(used.length).toBe(15);
    for (const g of used) {
      expect(tokens).toMatch(new RegExp(`\\.${g}\\s*\\{`), `.${g} 在令牌文件里没有定义`);
    }
  });

  test('卡片圆角与阴影来自令牌（卡片规则在行内副本里）', () => {
    const { body } = inlineCopy(indexHtml);
    expect(body).toMatch(/border-radius:\s*var\(--radius-card\)/);
    expect(body).toMatch(/box-shadow:\s*var\(--sh-xs\)/);
  });

  test('已打包插件的下载链接都指向 dist/ 里真实存在的包', () => {
    // 三个新插件的包在阶段二收尾统一生成；这里只对已经打包的 12 个严格要求。
    const links = [...doc.querySelectorAll('a[href^="dist/"]')].map((a) => a.getAttribute('href'));
    expect(links.length).toBe(15);
    const missing = links
      .filter((href) => !href.includes('pet-sense') && !href.includes('media-sync') && !href.includes('weather-env'))
      .filter((href) => !existsSync(path.join(marketRoot, href)));
    expect(missing, `下载链接指向不存在的文件：${missing.join(', ')}`).toEqual([]);
  });

  test('三个新插件都有自己的卡片与「新」标签', () => {
    for (const id of ['com.shixiansi.plugin-pet-sense', 'com.shixiansi.plugin-media-sync', 'com.shixiansi.plugin-weather-env']) {
      expect(indexHtml).toContain(`<code>${id}</code>`);
    }
    expect((indexHtml.match(/class="tag accent">新</g) || []).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. manage.html：管理页
// ---------------------------------------------------------------------------

describe('manage.html 管理页', () => {
  const $ = dom(manageHtml);
  const doc = $.window.document;

  test('零脚本：开关、胶囊、筛选全是 CSS，没有 <script> 与内联事件', () => {
    expect(doc.querySelectorAll('script').length).toBe(0);
    expect(doc.querySelectorAll('[onclick], [onchange], [oninput]').length).toBe(0);
  });

  test('插件行：图标 + 双状态胶囊 + 开关，一行不缺', () => {
    const rows = [...doc.querySelectorAll('section.plugin')];
    expect(rows.length).toBe(15);
    // 目录里的 15 个全部在列；三个新插件以停用态出现（装完先看清权限再启用）。
    expect(rows.filter((r) => r.dataset.state === 'running').length).toBe(12);
    expect(rows.filter((r) => r.dataset.state === 'disabled').length).toBe(3);
    for (const row of rows) {
      expect(row.querySelector('.icon svg'), '行里没有图标 SVG').not.toBeNull();
      expect(row.querySelector('.st-running'), '缺运行中胶囊').not.toBeNull();
      expect(row.querySelector('.st-disabled'), '缺已禁用胶囊').not.toBeNull();
      const input = row.querySelector('.switch input[type="checkbox"]');
      expect(input, '缺开关').not.toBeNull();
      // 胶囊声明静态初态：running 行有运行胶囊、disabled 行有停用胶囊
      const state = row.dataset.state;
      expect(['running', 'disabled']).toContain(state);
    }
  });

  test('静态 data-state 与开关 checked 一致（首帧不闪）', () => {
    for (const row of doc.querySelectorAll('section.plugin')) {
      const checked = row.querySelector('.switch input').hasAttribute('checked');
      expect(checked, `行 ${row.querySelector('h2').textContent} 的开关与 data-state 不一致`)
        .toBe(row.dataset.state === 'running');
    }
  });

  test('胶囊切换规则在行内样式里：:has(input) 同时管两个胶囊与卡片透明度', () => {
    const { body: copy } = inlineCopy(manageHtml);
    expect(copy).toMatch(/\.plugin:has\(input:not\(:checked\)\)\s*\.st-running\s*\{\s*display:\s*none/);
    expect(copy).toMatch(/\.plugin:has\(input:not\(:checked\)\)\s*\.st-disabled\s*\{\s*display:\s*inline-flex/);
    expect(copy).toMatch(/\.plugin:has\(input:not\(:checked\)\)\s*\{\s*opacity:\s*0\.62/);
  });

  test('开关动效：滑块 transform 位移 18px，跟随 :checked', () => {
    const { body: copy } = inlineCopy(manageHtml);
    expect(copy).toMatch(/\.switch input::after\s*\{[\s\S]*?transition:\s*transform var\(--dur\) ease/);
    expect(copy).toMatch(/\.switch input:checked::after\s*\{\s*transform:\s*translateX\(18px\)/);
  });

  test('底部交互栏：sticky、筛选 chips、批量动作齐全', () => {
    const bar = doc.querySelector('footer.bar');
    expect(bar, '没有底部交互栏').not.toBeNull();
    const { body: copy } = inlineCopy(manageHtml);
    expect(copy).toMatch(/\.bar\s*\{[^}]*position:\s*sticky/);
    // 三个筛选 radio，配对到 label
    const chips = bar.querySelectorAll('.chips input[type="radio"]');
    expect(chips.length).toBe(3);
    for (const input of chips) {
      expect(bar.querySelector(`label[for="${input.id}"]`), `radio ${input.id} 没有 label`).not.toBeNull();
    }
    expect(bar.querySelector('a.btn')?.getAttribute('href')).toBe('index.html');
  });

  test('纯 CSS 筛选规则在页面自有样式里（jsdom 不支持 :has，静态核对）', () => {
    // 筛选是管理页自有的规则，不属于共享令牌——所以在 manageHtml 全文里找。
    expect(manageHtml).toMatch(/body:has\(#f-on:checked\)\s+\.plugin\.hide-when-off\s*\{\s*display:\s*none/);
    expect(manageHtml).toMatch(/body:has\(#f-off:checked\)\s+\.plugin\.hide-when-on\s*\{\s*display:\s*none/);
    // 「全部」不能有 display 规则——它会以同等特异性压住上面两条（真实翻车过）。
    expect(manageHtml).not.toMatch(/body:has\(#f-all:checked\)[^{]*\{[^}]*display/);
  });

  test('每行都有筛选类（hide-when-off / hide-when-on 二选一）', () => {
    const rows = [...doc.querySelectorAll('section.plugin')];
    for (const row of rows) {
      const on = row.classList.contains('hide-when-off');
      const off = row.classList.contains('hide-when-on');
      expect(on !== off, '筛选类必须二选一').toBe(true);
      expect(on).toBe(row.dataset.state === 'running');
    }
  });

  test('颜色纪律：正文里不许有 style 属性写死颜色（脚注的设计说明文字豁免）', () => {
    const begin = manageHtml.indexOf(MASTER_END);
    const outside = manageHtml.slice(begin).replace(/<style>[\s\S]*?<\/style>/g, '');
    const styled = [...outside.matchAll(/style="[^"]*"/g)].map((m) => m[0]);
    const bad = styled.filter((attr) => /#[0-9a-fA-F]{3,8}\b/.test(attr));
    expect(bad, `style 属性写死了颜色：${bad.join(', ')}`).toEqual([]);
  });
});

// 市场页的卡片必须和 index.json 说同一句话。
//
// 2026-10-30 实测：memcore 的卡片停在 0.2.0，而实际发布的是 0.3.1——页面上那个"下载"按钮指向
// 一个 `dist/com.shixiansi.plugin-memcore-0.2.0.zip`，包是旧的。没人会手工比对 15 张卡片，
// 所以让测试来比。
describe('index.html 每张卡片与 index.json 一致', () => {
  const catalogue = JSON.parse(readFileSync(path.join(marketRoot, 'index.json'), 'utf8')).plugins;
  const byId = new Map(catalogue.map((p) => [p.id, p]));

  test('版本号、下载链接都指向 index.json 里那一个版本', () => {
    const cards = indexHtml.split(/(?=<section class="card)/).filter((b) => b.includes('com.shixiansi.plugin-'));
    expect(cards.length, '没找到任何插件卡片').toBeGreaterThan(0);
    const wrong = [];
    for (const block of cards) {
      const id = (block.match(/<code>(com\.shixiansi\.plugin-[a-z0-9-]+)<\/code>/) || [])[1];
      if (!id || !byId.has(id)) continue;
      const want = byId.get(id).version;
      const shown = (block.match(/版本 <code>([0-9.]+)<\/code>/) || [])[1];
      const link = (block.match(new RegExp(`dist/${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([0-9.]+)\\.zip`)) || [])[1];
      if (shown !== want || link !== want) wrong.push(`${id}: 页面=${shown} 链接=${link} 实际=${want}`);
    }
    expect(wrong, wrong.join('；')).toEqual([]);
  });

  test('每个下载链接都指向一个真的存在的包', () => {
    const missing = [];
    for (const p of catalogue) {
      const file = path.join(marketRoot, 'dist', `${p.id}-${p.version}.zip`);
      if (!existsSync(file)) missing.push(`${p.id}-${p.version}.zip`);
    }
    expect(missing, missing.join('、')).toEqual([]);
  });
});
