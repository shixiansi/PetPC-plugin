#!/usr/bin/env node
// tools/render-pages.mjs —— 从 index.json 生成两张静态页（index.html / manage.html）。
//
// # 为什么改成生成的
//
// 2026-11-01 的样式评审发现：index.json 有 36 个插件，而 index.html 与 manage.html 各只列了 18 个，
// manage 页还硬写着「全部 15 / 运行中 12 / 已停用 3」——三个数字互相打架，而后加的 18 个插件在
// 那两张页面上**根本不存在**。那两页是手写的，于是它们只在"有人记得同时改三处"的时候才是对的。
//
// 所以：**列表与计数一律生成，页面里不再有第二个真相**。prose（标题、说明、如何安装、页脚）留在这
// 个脚本里——它一年改一次，而列表每次发版都变。
//
// # 这页仍然是零脚本、零外链
//
// 筛选是纯 CSS（radio + `body:has()`）；令牌仍然是 docs/ui/market.css 的**逐字节副本**，由这里
// 内联进 `<style>`，哨兵注释与 tests/ui-market.test.js 约定的那两个一致。
//
// # 用法
//
//   node tools/render-pages.mjs            # 重写两张页面
//   node tools/render-pages.mjs --check    # 只对比，不一致就 exit 1（CI / 门禁用）

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const MASTER_BEGIN = '/* ==== market.css (inline copy of docs/ui/market.css) ==== */';
const MASTER_END = '/* ==== end market.css copy ==== */';
const OFFICIAL_AUTHOR = 'shixiansi';

const index = JSON.parse(readFileSync(join(repo, 'index.json'), 'utf8'));
const marketCss = readFileSync(join(repo, 'docs', 'ui', 'market.css'), 'utf8').replace(/\n+$/, '\n');

const plugins = (index.plugins || []).slice().sort((a, b) => a.id.localeCompare(b.id));
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const isOfficial = (p) => (p.author || '').trim() === OFFICIAL_AUTHOR;
const category = (p) => (isOfficial(p) ? 'official' : 'community');
const categoryLabel = (p) => (isOfficial(p) ? '官方' : '社区');

/**
 * 渐变类：按 id 稳定散列到 8 格之一。
 *
 * 手写 36 条渐变是上一版腐坏的起点（加插件就得来加一行，忘了就少一格样式）。散列的结果是稳定的：
 * 同一个 id 永远同一个颜色，换机器、换顺序都一样。
 */
function gradientFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 100000;
  return `g-${h % 8}`;
}

/** 图标里那个字：取名字第一个字（英文取首字母大写）。 */
function glyphFor(name) {
  const first = [...String(name || '?').trim()][0] || '?';
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/** 包的时间：静态页能看到的最诚实的一个"还活着吗"的信号。 */
function updatedAt(entry) {
  const file = join(repo, entry.download);
  if (!existsSync(file)) return '';
  const when = statSync(file).mtime;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

const counts = {
  all: plugins.length,
  official: plugins.filter(isOfficial).length,
  community: plugins.filter((p) => !isOfficial(p)).length,
};

function chips() {
  return `    <div class="chips" role="radiogroup" aria-label="筛选">
      <input type="radio" name="filter" id="f-all" checked><label for="f-all">全部 ${counts.all}</label>
      <input type="radio" name="filter" id="f-official"><label for="f-official">官方 ${counts.official}</label>
      <input type="radio" name="filter" id="f-community"><label for="f-community">社区 ${counts.community}</label>
    </div>`;
}

function card(p) {
  const perms = (p.permissions || []).map((x, i) => `<span class="tag${i === 0 ? ' accent' : ''}">${esc(x)}</span>`).join('');
  const updated = updatedAt(p);
  return `  <section class="card hoverable is-${category(p)}" style="margin-bottom: var(--space-3)">
    <div class="card-head">
      <span class="icon ${gradientFor(p.id)}" aria-hidden="true">${esc(glyphFor(p.name))}</span>
      <div class="titles">
        <h2>${esc(p.name)}</h2>
        <div class="meta"><span>版本 <code>${esc(p.version)}</code></span><span>·</span><span>作者 <code>${esc(p.author)}</code></span><span>·</span><code>${esc(p.id)}</code></div>
      </div>
    </div>
    <p class="desc">${esc(p.description)}</p>
    <div class="tags">
      ${perms}
    </div>
    <div class="actions">
      <a class="btn primary" href="${esc(p.download)}" download>下载 ${esc(p.version)}</a>
      <span class="meta">${updated ? `更新于 ${updated} · ` : ''}${esc(p.download)}</span>
    </div>
  </section>`;
}

function row(p) {
  const permCount = (p.permissions || []).length;
  return `  <section class="card plugin-row plugin hoverable is-${category(p)}" data-cat="${category(p)}" style="margin-bottom: var(--space-3)">
    <span class="icon ${gradientFor(p.id)}" aria-hidden="true">${esc(glyphFor(p.name))}</span>
    <div class="titles">
      <h2>${esc(p.name)}</h2>
      <div class="meta"><code>${esc(p.id)}</code><span>·</span><span>v${esc(p.version)}</span><span>·</span><span>${permCount} 项权限</span></div>
    </div>
    <span class="tag">${categoryLabel(p)}</span>
  </section>`;
}

/**
 * 两张页面共用的额外样式。
 *
 * 只放 market.css 里不该有的东西：筛选规则是**这两张页面**的机制，不是设计令牌的一部分。
 */
const EXTRA_CSS = `/* ==== 生成器附加：分类筛选（纯 CSS） ==== */
body:has(#f-official:checked) .is-community { display: none; }
body:has(#f-community:checked) .is-official { display: none; }
.page > .chips { margin-bottom: var(--space-4); }
.icon { font-size: 16px; font-weight: 700; line-height: 1; }
`;

const STYLE = `${MASTER_BEGIN}\n${marketCss}${MASTER_END}\n${EXTRA_CSS}`;

function head(title) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${STYLE}</style>
</head>
<body>
<main class="page">`;
}

const pageIndex = `${head('PetPC 插件市场')}
  <header class="head">
    <div class="head-row">
      <div>
        <h1>PetPC 插件市场</h1>
        <p class="lede">${counts.all} 个插件（官方 ${counts.official} · 社区 ${counts.community}）。每个插件就是一个目录（<code>manifest.json</code> + 前端资源），打包成 zip 后由宿主安装；机器可读版本是同目录的 <a href="index.json">index.json</a>。本页的列表与计数由 <code>tools/render-pages.mjs</code> 从 index.json 生成，不手维护。</p>
      </div>
      <a class="btn ghost" href="manage.html">插件管理 →</a>
    </div>
  </header>

${chips()}

<div class="grid" id="list">
${plugins.map(card).join('\n\n')}
</div>

  <section class="card" style="margin-top: var(--space-4)">
    <h2 style="margin:0 0 var(--space-2); font-size:16px">如何安装</h2>
    <ol style="margin:0; padding-left: var(--space-5)">
      <li>在桌宠里打开「插件」标签页，把市场地址填成你使用的基址（默认走镜像）；</li>
      <li>在列表里点安装，桌宠会下载 zip、校验 sha256、解压到 <code>%AppData%\\PetPC\\plugins\\&lt;插件id&gt;\\</code>；</li>
      <li>安装完成后插件处于停用状态：先看清它申请的权限，再自行启用并逐项授权。</li>
    </ol>
    <p class="meta" style="margin-top: var(--space-3)">离线也可以安装：桌宠内置了同一份插件包作为兜底源。完整的目录结构、打包发版步骤与镜像基址，见仓库根目录的 <a href="README.md">README.md</a>；每个插件声明的含义见 <a href="docs/plugin-dev.md">插件开发手册</a>。</p>
  </section>

  <p class="foot">本页是仓库内的静态 HTML，不执行任何脚本、不加载任何外部资源；设计令牌见 <code>docs/ui/market.css</code>（主色 #7C3AED、卡片圆角 18px、阴影 var(--sh-xs)、间距 4px 倍数）。列表与计数由 <code>tools/render-pages.mjs</code> 从 <code>index.json</code> 生成，DOM 校验见 <code>tests/ui-market.test.js</code>。</p>
</main>
</body>
</html>
`;

const pageManage = `${head('PetPC 插件管理')}
  <header class="head">
    <div class="head-row">
      <div>
        <h1>插件管理</h1>
        <p class="lede">共 ${counts.all} 个插件（官方 ${counts.official} · 社区 ${counts.community}）。<strong>启停与授权在控制中心里做</strong>（「插件」页：勾选即生效、逐项授权），这一页不假装知道它们——一张静态页读不到 <code>%AppData%\\PetPC\\plugins.json</code>，上一版在这里写死的「15 / 12 / 3」就是这么来的。</p>
      </div>
      <a class="btn ghost" href="index.html">← 插件市场</a>
    </div>
  </header>

${chips()}

<div class="grid" id="list">
${plugins.map(row).join('\n\n')}
</div>

  <p class="foot">本页与市场页共用一套设计令牌（<code>docs/ui/market.css</code>：主色 #7C3AED、卡片圆角 18px、阴影 var(--sh-xs)、间距 4px 倍数、46×46 渐变图标）。页面零脚本：筛选是纯 CSS（radio + <code>body:has()</code>）；列表与计数由 <code>tools/render-pages.mjs</code> 从 <code>index.json</code> 生成，DOM 校验见 <code>tests/ui-market.test.js</code>。</p>
</main>
</body>
</html>
`;

const targets = [
  ['index.html', pageIndex],
  ['manage.html', pageManage],
];

const check = process.argv.includes('--check');
let drift = 0;
for (const [name, want] of targets) {
  const path = join(repo, name);
  const have = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (have === want) {
    if (!check) console.log(`${name}：已是最新`);
    continue;
  }
  if (check) {
    drift += 1;
    console.error(`${name} 与 index.json 不一致——运行 node tools/render-pages.mjs 重新生成`);
    continue;
  }
  writeFileSync(path, want);
  console.log(`${name}：已重新生成（${plugins.length} 个插件）`);
}
if (check && drift > 0) process.exit(1);
if (check) console.log(`OK：两张页面都是从 index.json 生成的（${plugins.length} 个插件）`);
