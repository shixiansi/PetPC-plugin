#!/usr/bin/env node
// tools/check-catalogue.mjs —— index.json / plugins/ / dist/ 三者必须说同一件事。
//
// # 为什么需要它
//
// 2026-10-31 的 main 上，18 个插件**有源码、没有条目**：市场页点下载是 404，宿主也装不上。
// 而当时所有测试都是绿的——因为没有任何一条检查同时看这三处：插件测试只看插件、打包脚本只写
// 自己那份、市场页只读 index.json。
//
// 另一件同源的事：`index.json` 是**打包脚本生成的**，不是手写的。手改一个版本号、或者重新打包
// 之后忘了重跑，就会出现"条目指向一个不存在的 zip"或者"同一个版本两种字节"，而这两种失败在
// 界面上都表现为"下载失败"，说不清原因。
//
// # 它检查什么
//
//   1. plugins/<id>/manifest.json 里的每个 id 都在 index.json 里（否则市场里看不到、装不上）
//   2. index.json 的每个条目都有对应的插件目录（否则市场页会列出一个装不上的插件）
//   3. version / permissions / netHosts 与 manifest 逐项一致（条目不能是手抄的）
//   4. download 指向的 zip 存在，且 sha256 与条目一致
//
// （**不**在这里查 ui.css 的副本一致性：`tests/ui-tokens.test.js` 已经查了——一份源头、
//  多份副本逐字节相同、且必须写进 assets。两处都查就是第二份真理，哪天它们对同一份文件
//  给出不同的判决，谁也不知道该信哪个。）
//
// # 用法
//
//   node tools/check-catalogue.mjs
//
// 退出码：0 = 没问题；1 = 有问题；2 = 用法错误。
// 它不联网、不依赖宿主仓，和 `docs/plugin-testkit/plugin-check.mjs` 一样可以整个拷走。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const pluginsDir = join(repo, 'plugins');
const indexPath = join(repo, 'index.json');

const problems = [];
const fail = (message) => problems.push(message);
const list = (v) => [...(Array.isArray(v) ? v : [])].sort().join(',');

if (!existsSync(indexPath)) {
  console.error('index.json 不存在：先在插件仓根目录运行');
  process.exit(2);
}

let index;
try {
  index = JSON.parse(readFileSync(indexPath, 'utf8'));
} catch (err) {
  console.error(`index.json 不是合法 JSON：${err.message}`);
  process.exit(2);
}

const byId = new Map();
for (const entry of index.plugins || []) {
  if (!entry || typeof entry.id !== 'string') {
    fail('index.json 里有一个条目没有 id');
    continue;
  }
  if (byId.has(entry.id)) fail(`index.json 里 ${entry.id} 出现了两次`);
  byId.set(entry.id, entry);
}

const dirs = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const seen = new Set();
for (const id of dirs) {
  const manifestPath = join(pluginsDir, id, 'manifest.json');
  if (!existsSync(manifestPath)) {
    fail(`plugins/${id}/ 没有 manifest.json`);
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(`plugins/${id}/manifest.json 不是合法 JSON：${err.message}`);
    continue;
  }
  seen.add(id);

  const entry = byId.get(id);
  if (!entry) {
    fail(`${id} 有源码但没有 index.json 条目：市场里看不到它，宿主也装不上`);
    continue;
  }
  if (entry.version !== manifest.version) {
    fail(`${id}: index.json 写 ${entry.version}，manifest 写 ${manifest.version}`);
  }
  if (list(entry.permissions) !== list(manifest.permissions)) {
    fail(`${id}: 权限不一致（index [${list(entry.permissions)}] / manifest [${list(manifest.permissions)}]）`);
  }
  if (list(entry.netHosts) !== list(manifest.netHosts)) {
    fail(`${id}: netHosts 不一致（index [${list(entry.netHosts)}] / manifest [${list(manifest.netHosts)}]）`);
  }
  if (!entry.download || typeof entry.download !== 'string') {
    fail(`${id}: 条目没有 download`);
    continue;
  }
  const zipPath = join(repo, entry.download);
  if (!existsSync(zipPath)) {
    fail(`${id}: 条目指向的包不存在：${entry.download}`);
    continue;
  }
  const sum = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  if (sum !== entry.sha256) {
    fail(`${id}: ${entry.download} 的 sha256 与条目不一致（重新打包之后忘了更新 index.json？）`);
  }
}

for (const id of byId.keys()) {
  if (!seen.has(id)) fail(`${id} 在 index.json 里，但 plugins/${id}/ 不存在`);
}

// ---------------------------------------------------------------------------
// 主题商店的货架（themes/index.json）
// ---------------------------------------------------------------------------
//
// A theme is one JSON file, so the checks differ from a package's, but the failure modes are the same
// two: a row pointing at a file that is not there, and a file whose bytes are not the ones the row
// hashed. The third is unique to themes and is why this section exists: a pack missing a scheme or a
// skeleton token installs fine and then does nothing visible - the user sees "装好了" and the window
// does not change.
const themesIndexPath = join(repo, 'themes', 'index.json');
const TOKEN_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const COLOUR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[0-9.]+%?\s*,\s*[0-9.]+%?\s*,\s*[0-9.]+%?\s*(?:,\s*[0-9.]+\s*)?\))$/;
const SKELETON = ['bg', 'bg-raised', 'bg-sunken', 'text', 'text-dim', 'accent', 'accent-strong', 'accent-soft'];
let themeCount = 0;

if (existsSync(themesIndexPath)) {
  let shelf = null;
  try {
    shelf = JSON.parse(readFileSync(themesIndexPath, 'utf8'));
  } catch (err) {
    fail(`themes/index.json 不是合法 JSON：${err.message}`);
  }
  for (const row of (shelf && shelf.themes) || []) {
    if (!row || typeof row.id !== 'string' || !TOKEN_NAME.test(row.id)) {
      fail(`主题商店里有一个条目没有合法的 id：${JSON.stringify(row)}`);
      continue;
    }
    if (!row.download || typeof row.download !== 'string') {
      fail(`主题包 ${row.id}: 条目没有 download`);
      continue;
    }
    const file = join(repo, row.download);
    if (!existsSync(file)) {
      fail(`主题包 ${row.id}: 条目指向的文件不存在：${row.download}`);
      continue;
    }
    const bytes = readFileSync(file);
    const sum = createHash('sha256').update(bytes).digest('hex');
    if (sum !== String(row.sha256 || '').toLowerCase()) {
      fail(`主题包 ${row.id}: ${row.download} 的 sha256 与条目不一致`);
    }
    let pack = null;
    try {
      pack = JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      fail(`主题包 ${row.id}: ${row.download} 不是合法 JSON：${err.message}`);
      continue;
    }
    if (pack.id !== row.id) fail(`主题包 ${row.id}: 文件里的 id 是 ${pack.id}`);
    themeCount += 1;
    for (const scheme of ['light', 'dark']) {
      const tokens = (pack.tokens || {})[scheme];
      if (!tokens || typeof tokens !== 'object') {
        fail(`主题包 ${row.id}: 缺少 tokens.${scheme}（两套都要写，只写一套的话切到另一侧就读不出来）`);
        continue;
      }
      for (const name of SKELETON) {
        if (!tokens[name]) fail(`主题包 ${row.id}: tokens.${scheme} 缺少骨架令牌 ${name}`);
      }
      for (const [name, value] of Object.entries(tokens)) {
        if (!TOKEN_NAME.test(name)) fail(`主题包 ${row.id}: 令牌名不合法：${name}`);
        if (typeof value !== 'string' || !COLOUR.test(value.trim())) {
          fail(`主题包 ${row.id}: ${scheme} 的 ${name} 不是颜色字面量：${JSON.stringify(value)}`);
        }
      }
    }
  }
}

if (problems.length === 0) {
  const shelfNote = themeCount > 0 ? `、主题包 ${themeCount} 个` : '';
  console.log(`OK：${dirs.length} 个插件、${byId.size} 个条目${shelfNote}、包与摘要全部对得上`);
  process.exit(0);
}
console.error(`发现 ${problems.length} 个问题：`);
for (const problem of problems) console.error(`  FAIL  ${problem}`);
process.exit(1);
