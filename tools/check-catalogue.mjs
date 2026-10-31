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

if (problems.length === 0) {
  console.log(`OK：${dirs.length} 个插件、${byId.size} 个条目、包与摘要全部对得上`);
  process.exit(0);
}
console.error(`发现 ${problems.length} 个问题：`);
for (const problem of problems) console.error(`  FAIL  ${problem}`);
process.exit(1);
