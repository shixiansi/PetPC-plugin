import { describe, expect, test } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 插件页面的样式：**一份源头，多份副本，逐字相同**。
//
// 为什么需要这个文件：插件文档是 opaque origin 的 iframe，宿主的 CSS 变量进不去，所以
// 「继承 token」在 PetPC 里只能靠"把同一份定义打进每个插件包"。副本一旦和源头分叉，就会出现
// 第三套色板——那正是 2026-10-29 三个新插件"各写各的、看起来都丑"的原因。
//
// 这里钉五件事：
//   1. `docs/ui/petpc-ui.css` 与宿主共享**词表**（token 名字），值可以是 Soft UI 的；
//   2. 它是 Soft UI：24px 卡片圆角、16px 控件圆角、violet 主色、带色透明阴影、无纯黑、
//      不用 Inter/Roboto/Geist、尊重 prefers-reduced-motion；
//   3. 每个用它的插件，包内那份 `ui.css` 与源头**逐字节相同**，且写进 `assets`；
//   4. 这些插件的 `style.css` 里**不许再出现十六进制色值**（颜色只能来自 token）；
//   5. 每个插件——不分新旧——页面引用的本地文件都必须写进 `assets`，否则**打不进包**。

const here = path.dirname(fileURLToPath(import.meta.url));
const marketRoot = path.join(here, '..');
const pluginsRoot = path.join(marketRoot, 'plugins');
const masterPath = path.join(marketRoot, 'docs', 'ui', 'petpc-ui.css');
const hostTokensPath = path.join(marketRoot, '..', 'tools', 'plugin-market', 'cc', 'src', 'tokens.css');

/** 打包器总是带的三个文件；其余任何被页面引用的文件都必须出现在 `manifest.assets` 里。 */
const ALWAYS_SHIPPED = ['panel.html', 'app.js', 'style.css'];

/** 每一个插件目录。 */
const PLUGIN_IDS = readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/**
 * 采用了共享样式表的插件——**扫出来的，不是手写的**。
 *
 * 这里原来是一份四个 id 的常量，注释写着"加一个 id 就是全部的 opt-in"。那份清单就是事故本身：
 * pet-sense / media-sync / weather-env 三个插件写了 `ui.css`、页面也引用了它，但没人想起往这
 * 份清单里加一行，于是"副本分叉""必须写进 assets""不许写死颜色"三条断言对它们**一条都没跑**，
 * 而它们恰恰就是错的（assets 没列 ui.css → 发出去的包里没有那份文件）。手维护的清单必然分叉。
 */
const ADOPTERS = PLUGIN_IDS.filter((id) => existsSync(path.join(pluginsRoot, id, 'ui.css')));


/** Every `--name:` a stylesheet declares. */
function tokenNames(text) {
  return new Set([...text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
}

describe('the shared plugin stylesheet', () => {
  test('exists', () => {
    expect(existsSync(masterPath), 'docs/ui/petpc-ui.css 不存在').toBe(true);
  });

  test('shares the host token NAMES (values may differ: plugins run Soft UI)', () => {
    const master = readFileSync(masterPath, 'utf8');
    const ours = tokenNames(master);
    for (const required of [
      '--bg', '--bg-raised', '--line', '--text', '--text-dim', '--accent',
      '--radius', '--radius-xl', '--space-4', '--space-5', '--sh-xs', '--sh-md', '--sh-lg',
    ]) {
      expect(ours.has(required), `ui.css 缺少 token ${required}`).toBe(true);
    }
    if (!existsSync(hostTokensPath)) return; // 插件仓单独检出时没有宿主
    const host = tokenNames(readFileSync(hostTokensPath, 'utf8'));
    for (const shared of ['--bg', '--bg-raised', '--line', '--text', '--accent', '--radius', '--space-5']) {
      expect(host.has(shared), `宿主 tokens.css 里没有 ${shared}（词表分叉）`).toBe(true);
    }
  });

  test('is the Soft UI flavour: big radii, tinted shadows, no pure black', () => {
    const master = readFileSync(masterPath, 'utf8');
    expect(master, '卡片圆角应当是 24px（rounded-3xl）').toContain('--radius-xl: 24px');
    expect(master, '控件圆角应当是 16px（rounded-2xl）').toContain('--radius: 16px');
    expect(master, '主色应当是 violet-600（与市场页同族，2026-10 收敛）').toContain('--accent: #7c3aed');
    expect(master, '阴影必须带颜色与透明度').toMatch(/--sh-sm: 0 6px 16px -6px rgba\(/);
    expect(master, '禁止纯黑').not.toMatch(/#000\b|#000000/i);
    expect(master, '必须尊重 prefers-reduced-motion').toContain('prefers-reduced-motion');
    // 只看真正的 font 声明：注释里就写着「禁止这些字体」，不该被当成违规。
    const fontLine = (master.match(/--font:[^;]+;/) || [''])[0];
    expect(fontLine, '禁止 Inter / Roboto / Geist').not.toMatch(/Inter|Roboto|Geist/);
  });

  test('defines both schemes', () => {
    const master = readFileSync(masterPath, 'utf8');
    expect(master).toContain(':root[data-theme="dark"]');
    expect(master).toMatch(/--bg: #0f172a/);
  });

  for (const id of ADOPTERS) {
    describe(id, () => {
      test('ships a byte-identical copy', () => {
        const copyPath = path.join(marketRoot, 'plugins', id, 'ui.css');
        expect(existsSync(copyPath), `${id} 没有 ui.css`).toBe(true);
        expect(readFileSync(copyPath, 'utf8'), `${id} 的 ui.css 与源头分叉了`).toBe(
          readFileSync(masterPath, 'utf8'),
        );
      });

      test('links it before its own stylesheet', () => {
        const html = readFileSync(path.join(marketRoot, 'plugins', id, 'panel.html'), 'utf8');
        const uiAt = html.indexOf('href="ui.css"');
        const ownAt = html.indexOf('href="style.css"');
        expect(uiAt, `${id} 没有引用 ui.css`).toBeGreaterThan(-1);
        expect(ownAt, `${id} 没有引用 style.css`).toBeGreaterThan(-1);
        expect(uiAt, `${id} 的 ui.css 必须在 style.css 之前（否则会被覆盖）`).toBeLessThan(ownAt);
      });

      test('declares it as an asset, or it will not be packaged', () => {
        const manifest = JSON.parse(readFileSync(path.join(marketRoot, 'plugins', id, 'manifest.json'), 'utf8'));
        expect(manifest.assets, `${id} 的 assets 里没有 ui.css`).toContain('ui.css');
      });

      test('its own stylesheet hardcodes no colour', () => {
        const css = readFileSync(path.join(marketRoot, 'plugins', id, 'style.css'), 'utf8');
        const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
        expect(hex, `${id} 的 style.css 里写死了颜色：${hex.join(', ')}（应该用 var(--…)）`).toEqual([]);
      });
    });
  }
});

describe('every file a page references is declared', () => {
  // 这一组对**所有**插件生效，不只引了 ui.css 的那几个。
  //
  // 打包器只发 panel.html / app.js / style.css 加 manifest.assets（`tools/package.py` 的
  // FIXED + assets）。所以"页面引用了、文件也在、但没写进 assets"的资源，在仓库里怎么跑都正常，
  // 到了装好的插件里就是不存在——症状是"页面能开、样式没了"，而作者本地永远复现不出来。
  //
  // 2026-10-30 的原件：三个插件的 panel.html 引用 `ui.css`、磁盘上有 `ui.css`、assets 里没有它。
  // 它们的 style.css 里 0 个十六进制色值、9 处 `var(--…)` 都没有 fallback，于是配色整个空掉，
  // 用户看到的就是"新插件没按风格来"。
  for (const id of PLUGIN_IDS) {
    test(`${id} declares every local file its document loads`, () => {
      const dir = path.join(pluginsRoot, id);
      const entry = 'panel.html';
      if (!existsSync(path.join(dir, entry))) return; // 没有界面的插件不在这一组的范围里
      const html = readFileSync(path.join(dir, entry), 'utf8');
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      const declared = new Set([
        ...ALWAYS_SHIPPED,
        ...(manifest.assets ?? []).map((a) => String(a).replace(/^\.\//, '')),
      ]);
      const missing = new Set();
      for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        const raw = m[1].trim();
        if (!raw || raw.startsWith('#') || raw.startsWith('//')) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http(s)、data: …
        const ref = raw.replace(/^\.\//, '').split('?')[0].split('#')[0];
        // 文件不存在是另一条检查的事（plugin-check 的 referenced-file）；这里只管"会被打包吗"。
        if (!existsSync(path.join(dir, ref))) continue;
        if (!declared.has(ref)) missing.add(ref);
      }
      expect([...missing], `${id}: 这些文件被页面引用、但没进 assets，打包后不存在：${[...missing].join(', ')}`).toEqual([]);
    });
  }
});
