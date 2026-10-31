#!/usr/bin/env node
// PetPC 插件自检工具 —— 零必需依赖（jsdom 只在协议那一组需要）。
//
// 用法：
//   node plugin-check.mjs <插件目录> [更多目录…]
//   node plugin-check.mjs plugins/*                 # 一次查一批（本仓的插件都在 plugins/ 下）
//   node plugin-check.mjs . --only=manifest,source  # 只跑某几组
//   node plugin-check.mjs . --json                  # 机器可读
//
// 退出码：0 = 没有 FAIL；1 = 有 FAIL；2 = 用法错误。
//
// 它检查什么、为什么那样判定，见同目录的 README.md。这里只重复一条：
//
//   **它不需要宿主程序，也不需要宿主的源码。** 方法表、权限表、结果表都在同目录的
//   `fake-host.mjs` 里，与《插件开发手册》（docs/plugin-dev.md）第 4/6 节一一对应。宿主版本比
//   这个文件新时，可能"少报"（它不认识新方法，所以不会替你检查）；反过来它不会误报已存在的方法。
//
// 为什么方法表不在本文件里：`preview.html`（真浏览器里的排版预览）需要**同一套**假宿主与结果表，
// 两套必然分叉，而分叉的假宿主比没有更坏——它会告诉你"没问题"。所以：一个 `fake-host.mjs`，
// 两个执行环境（jsdom 与真 Chromium），协议知识只写一次。
//
// 四组检查：manifest（纯 JSON 规则）· package（文件在不在）· source（静态文本规则）·
// protocol（把文档真的跑起来，用一个照抄宿主的假宿主驱动）。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PERMISSIONS, METHODS, createFakeHost } from './fake-host.mjs';

// ---------------------------------------------------------------------------
// 契约常量：权限表 / 方法表 / 结果表在 `fake-host.mjs`（预览页共用那一份）。这里只剩 manifest
// 的上限，因为它们只跟"清单合不合法"有关，跟协议无关。
// ---------------------------------------------------------------------------

const LIMITS = {
  idLen: 96,
  nameRunes: 64,
  descriptionRunes: 512,
  surfaceRects: 8,
  rectEdge: 2000,
  rectRadius: 200,
  rectOffset: 4000,
  configItems: 40,
  configLabel: 64,
  configOptions: 64,
  assets: 32,
  shareRead: 8,
  callList: 8,
  entry: null,
};

const ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const NET_HOST_PATTERN = /^[A-Za-z0-9.-]+(:\d+)?$/;
const CONFIG_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// 一个被服务的方法名，和宿主 manifest.go 的 servedMethodPattern 是同一个形状（点可以是
// "memory.get" 这种名字，但永不落到文件系统上）。
const SERVED_METHOD_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const CONFIG_TYPES = ['text', 'number', 'bool', 'secret', 'select'];
const PANEL_SLOTS = ['', 'chat', 'todos', 'pomodoro'];

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------

const RANK = { SKIP: 0, PASS: 1, WARN: 2, FAIL: 3 };

function newReport(dir) {
  return { dir, checks: [], add(group, id, status, message, hint) { this.checks.push({ group, id, status, message, hint }); } };
}

function failCount(r) {
  return r.checks.filter((c) => c.status === 'FAIL').length;
}
function warnCount(r) {
  return r.checks.filter((c) => c.status === 'WARN').length;
}

// ---------------------------------------------------------------------------
// 组 1：manifest
// ---------------------------------------------------------------------------

function runes(s) {
  return [...String(s ?? '')].length;
}

function checkManifest(report, manifest) {
  const add = (id, status, message, hint) => report.add('manifest', id, status, message, hint);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    add('manifest-parse', 'FAIL', 'manifest.json 不是一个 JSON 对象');
    return null;
  }

  const str = (v) => (typeof v === 'string' ? v : '');
  const id = str(manifest.id);
  if (!id) add('id-missing', 'FAIL', '缺少必填字段 id');
  else if (id.length > LIMITS.idLen) add('id-long', 'FAIL', `id 超过 ${LIMITS.idLen} 字符`);
  else if (!ID_PATTERN.test(id)) add('id-shape', 'FAIL', `id 不是反向域名式的小写标识：${JSON.stringify(id)}`, '例：com.example.hello（只能小写字母数字、点、连字符）');

  const name = str(manifest.name);
  if (!name) add('name-missing', 'FAIL', '缺少必填字段 name');
  else if (runes(name) > LIMITS.nameRunes) add('name-long', 'FAIL', `name 超过 ${LIMITS.nameRunes} 字符`);

  if (!str(manifest.author)) add('author-missing', 'FAIL', '缺少必填字段 author');
  const desc = str(manifest.description);
  if (!desc) add('description-missing', 'FAIL', '缺少必填字段 description');
  else if (runes(desc) > LIMITS.descriptionRunes) add('description-long', 'FAIL', `description 超过 ${LIMITS.descriptionRunes} 字符`);

  const version = str(manifest.version);
  if (!version) add('version-missing', 'FAIL', '缺少必填字段 version');
  else if (!VERSION_PATTERN.test(version)) add('version-shape', 'FAIL', `version 不是语义化版本：${JSON.stringify(version)}`, '例：1.0.0 或 1.0.0-beta.1');

  const perms = Array.isArray(manifest.permissions) ? manifest.permissions : null;
  const declared = new Set();
  if (!perms) add('permissions-missing', 'FAIL', '字段 permissions 必须是数组（可以是空数组）');
  else {
    const seen = new Set();
    for (const p of perms) {
      if (typeof p !== 'string' || !(p in PERMISSIONS)) add('permission-unknown', 'FAIL', `permissions 含非法权限名 ${JSON.stringify(p)}`, '14 项见手册 4.1 节');
      else if (seen.has(p)) add('permission-dup', 'FAIL', `permissions 含重复项 ${p}`);
      else declared.add(p);
      seen.add(p);
    }
  }

  const netHosts = Array.isArray(manifest.netHosts) ? manifest.netHosts : [];
  for (const h of netHosts) {
    if (typeof h !== 'string' || !NET_HOST_PATTERN.test(h)) add('netHosts-shape', 'FAIL', `netHosts 含非法主机名 ${JSON.stringify(h)}`, '形如 api.example.com 或 127.0.0.1:3000');
  }
  if (declared.has('net.fetch') && netHosts.length === 0) {
    add('netHosts-missing', 'FAIL', '声明了 net.fetch 却没有 netHosts 白名单', '没有白名单的 allow-list 等于允许一切，安装会被拒');
  }
  if (declared.has('net.credentials') && !declared.has('net.fetch')) {
    add('credentials-without-fetch', 'FAIL', 'net.credentials 是 net.fetch 的第二道闸，必须同时声明 net.fetch');
  }
  if (manifest.shareLLM === true && !declared.has('llm.chat')) {
    add('shareLLM-without-chat', 'FAIL', 'shareLLM 借出的是自己调模型的配置，必须同时声明 llm.chat');
  }

  // entry + 界面落点
  const entry = str(manifest.entry);
  const surface = Array.isArray(manifest.surface) ? manifest.surface : [];
  const hasBackground = manifest.background === true;
  if (!entry) add('entry-missing', 'FAIL', '缺少必填字段 entry');
  else {
    if (entry.startsWith('/')) add('entry-absolute', 'FAIL', `entry 不能是绝对路径：${entry}`);
    if (entry.includes('\\')) add('entry-backslash', 'FAIL', `entry 不能包含反斜杠：${entry}`, '用 / 分隔');
    if (entry.includes('..')) add('entry-relative-escape', 'FAIL', `entry 不能包含 ..：${entry}`);
    if (!entry.endsWith('.html')) add('entry-html', 'FAIL', `entry 必须以 .html 结尾：${entry}`);
  }
  if (manifest.panel !== true && surface.length === 0 && !hasBackground) {
    add('no-mount-point', 'FAIL', '必须声明 panel / surface / background 之一：否则没有任何宿主会加载这个 entry');
  }
  if (hasBackground && !['events', 'net.ws', 'net.fetch', 'plugin.call'].some((p) => declared.has(p))) {
    add('background-without-permission', 'FAIL', 'background 需要 events / net.ws / net.fetch / plugin.call 之一（常驻帧的用途是无人看着时收发消息）');
  }

  // panelSlot
  const slot = str(manifest.panelSlot);
  if (slot !== '' && !PANEL_SLOTS.includes(slot)) add('panelSlot-unknown', 'FAIL', `panelSlot 只接受 "" / "chat" / "todos" / "pomodoro"，收到 ${JSON.stringify(slot)}`);
  else if (slot === 'chat' && manifest.panel !== true) add('panelSlot-chat', 'FAIL', 'panelSlot=chat 要求 panel 为 true');
  else if ((slot === 'todos' || slot === 'pomodoro') && surface.length === 0) add('panelSlot-surface', 'FAIL', `panelSlot=${slot} 要求声明 surface 矩形（那一格打开的是你自己的浮层面）`);

  // shareRead
  const shareRead = Array.isArray(manifest.shareRead) ? manifest.shareRead : [];
  if (shareRead.length > 0 && !declared.has('plugin.share')) {
    add('shareRead-without-permission', 'FAIL', '声明了 shareRead 却没有 plugin.share 权限');
  }
  if (shareRead.length > LIMITS.shareRead) add('shareRead-long', 'FAIL', `shareRead 最多 ${LIMITS.shareRead} 项`);
  {
    const seen = new Set();
    for (const item of shareRead) {
      const parts = String(item).split('/');
      if (parts.length !== 2) { add('shareRead-shape', 'FAIL', `shareRead 项必须形如 "<插件id>/<名字>"：${JSON.stringify(item)}`); continue; }
      const [owner, key] = parts;
      if (!ID_PATTERN.test(owner)) add('shareRead-owner', 'FAIL', `shareRead 的 owner 不是合法插件 id：${owner}`);
      if (!CONFIG_KEY_PATTERN.test(key)) add('shareRead-name', 'FAIL', `shareRead 的键名不是扁平名（[A-Za-z0-9_-]{1,64}）：${key}`);
      if (owner === id) add('shareRead-self', 'FAIL', 'shareRead 不该列出自己（读自己的值是默认允许的）');
      if (seen.has(item)) add('shareRead-dup', 'FAIL', `shareRead 有重复项 ${item}`);
      seen.add(item);
    }
  }

  // serving: 我会答哪些方法；calling: 我能问谁。宿主对这两张表的规则见手册 4 节与 6.8。
  const serves = Array.isArray(manifest.serves) ? manifest.serves : [];
  const callTargets = Array.isArray(manifest.callTargets) ? manifest.callTargets : [];
  if ((serves.length > 0 || callTargets.length > 0) && !declared.has('plugin.call')) {
    add('call-without-permission', 'FAIL', '声明了 serves / callTargets 却没有 plugin.call 权限（两端都要有这把开关）');
  }
  if (serves.length > LIMITS.callList) add('serves-long', 'FAIL', `serves 最多 ${LIMITS.callList} 项`);
  {
    const seen = new Set();
    for (const name of serves) {
      if (typeof name !== 'string' || !SERVED_METHOD_PATTERN.test(name)) {
        add('serves-shape', 'FAIL', `serves 项不是合法方法名（[A-Za-z0-9_.-]{1,64}）：${JSON.stringify(name)}`);
        continue;
      }
      if (seen.has(name)) add('serves-dup', 'FAIL', `serves 有重复项 ${name}`);
      seen.add(name);
    }
  }
  if (callTargets.length > LIMITS.callList) add('callTargets-long', 'FAIL', `callTargets 最多 ${LIMITS.callList} 项`);
  {
    const seen = new Set();
    for (const item of callTargets) {
      // 可选的版本下限："<插件id>/<方法名>@>=1.2.3"（手册 §4 的 callTargets 那一行）。
      // 有它的时候，被调用方的版本低于它，宿主会在 plugin.call 里拒绝并写明两个版本。
      const raw = typeof item === 'string' ? item : '';
      const at = raw.indexOf('@');
      const pair = at >= 0 ? raw.slice(0, at) : raw;
      const floor = at >= 0 ? raw.slice(at) : '';
      if (floor && !/^@>=\d+\.\d+\.\d+$/.test(floor)) {
        add('callTargets-floor', 'FAIL', `callTargets 的版本下限必须形如 "@>=1.2.3"：${JSON.stringify(item)}`);
        continue;
      }
      const parts = pair.split('/');
      if (parts.length !== 2) { add('callTargets-shape', 'FAIL', `callTargets 项必须形如 "<插件id>/<方法名>"：${JSON.stringify(item)}`); continue; }
      const [target, method] = parts;
      if (!ID_PATTERN.test(target)) add('callTargets-target', 'FAIL', `callTargets 的目标不是合法插件 id：${target}`);
      if (!SERVED_METHOD_PATTERN.test(method)) add('callTargets-method', 'FAIL', `callTargets 的方法名不合法（[A-Za-z0-9_.-]{1,64}）：${method}`);
      if (target === id) add('callTargets-self', 'FAIL', 'callTargets 不该列出自己（那是循环，不是调用）');
      // 去重按"这一对"，和宿主一样：同一对写两遍、版本下限不同，是同一个授权的两个说法。
      if (seen.has(pair)) add('callTargets-dup', 'FAIL', `callTargets 有重复项 ${pair}`);
      seen.add(pair);
    }
  }

  // assets
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (assets.length > LIMITS.assets) add('assets-long', 'FAIL', `assets 最多 ${LIMITS.assets} 项`);
  {
    const seen = new Set();
    for (const a of assets) {
      if (typeof a !== 'string' || !validRelPath(a)) add('assets-shape', 'FAIL', `assets 里的 ${JSON.stringify(a)} 不是合法的相对路径`);
      else if (seen.has(a)) add('assets-dup', 'FAIL', `assets 含重复路径 ${a}`);
      seen.add(a);
    }
  }

  // config
  const config = Array.isArray(manifest.config) ? manifest.config : [];
  if (config.length > LIMITS.configItems) add('config-long', 'FAIL', `config 最多 ${LIMITS.configItems} 项，收到 ${config.length}`);
  {
    const seen = new Set();
    let whitelists = 0;
    config.forEach((item, i) => {
      if (!item || typeof item !== 'object') { add('config-shape', 'FAIL', `config 第 ${i} 项不是对象`); return; }
      const key = str(item.key);
      if (!CONFIG_KEY_PATTERN.test(key)) add('config-key', 'FAIL', `config 第 ${i} 项的 key 非法：${JSON.stringify(key)}`, '^[A-Za-z0-9_-]{1,64}$');
      else if (seen.has(key)) add('config-key-dup', 'FAIL', `config 含重复 key ${key}`);
      seen.add(key);
      if (!str(item.label).trim()) add('config-label', 'FAIL', `config 的 ${key || i} 缺少 label`);
      else if (runes(item.label) > LIMITS.configLabel) add('config-label-long', 'FAIL', `config 的 ${key} label 超过 ${LIMITS.configLabel} 字符`);
      if (!CONFIG_TYPES.includes(str(item.type))) add('config-type', 'FAIL', `config 的 ${key} type 非法：${JSON.stringify(item.type)}`, CONFIG_TYPES.join(' / '));
      if ((item.secret === true) !== (str(item.type) === 'secret')) add('config-secret-type', 'FAIL', `config 的 ${key}: secret 必须与 type="secret" 一致`);
      if (item.hostWhitelist === true) whitelists += 1;
      if (str(item.type) === 'select') {
        if (item.secret === true || item.hostWhitelist === true) add('config-select-flags', 'FAIL', `config 的 ${key} 是 select，不能同时是 secret 或 hostWhitelist`);
        const options = Array.isArray(item.options) ? item.options : [];
        if (options.length < 2 || options.length > LIMITS.configOptions) add('config-select-options', 'FAIL', `config 的 ${key} 是 select，需要 2–${LIMITS.configOptions} 个 options，收到 ${options.length}`);
        const vals = new Set();
        for (const o of options) {
          if (!o || !str(o.value).trim()) add('config-select-value', 'FAIL', `config 的 ${key} 有选项缺少 value`);
          else if (vals.has(o.value)) add('config-select-value-dup', 'FAIL', `config 的 ${key} 有重复选项 value ${JSON.stringify(o.value)}`);
          else vals.add(o.value);
          if (!o || !str(o.label).trim()) add('config-select-label', 'FAIL', `config 的 ${key} 的选项 ${JSON.stringify(o?.value)} 缺少 label`);
        }
      } else if (Array.isArray(item.options) || item.multiple === true) {
        add('config-options-without-select', 'FAIL', `config 的 ${key} 用了 options/multiple 但 type 不是 select`);
      }
    });
    // 最多 4 个，而且是**合并**的：接口域名与图片域名本来就该是两个字段（一个填 URL、
    // 一个填裸域名）。宿主的 maxHostWhitelists 也是 4。
    if (whitelists > 4) add('config-whitelist-many', 'FAIL', `config 最多允许 4 个 hostWhitelist 项，收到 ${whitelists}`);
  }

  // surface
  if (surface.length > LIMITS.surfaceRects) add('surface-many', 'FAIL', `surface 最多 ${LIMITS.surfaceRects} 块`);
  surface.forEach((r, i) => {
    if (!r || typeof r !== 'object') { add('surface-shape', 'FAIL', `surface 第 ${i} 块不是对象`); return; }
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    const w = num(r.w), h = num(r.h), radius = num(r.radius ?? 0);
    const dx = num(r.dx ?? 0), dy = num(r.dy ?? 0);
    if (!(w > 0) || !(h > 0)) add('surface-size', 'FAIL', `surface 第 ${i} 块宽高必须为正：w=${r.w} h=${r.h}`);
    else if (w > LIMITS.rectEdge || h > LIMITS.rectEdge) add('surface-size-max', 'FAIL', `surface 第 ${i} 块宽高上限 ${LIMITS.rectEdge}：w=${w} h=${h}`);
    if (!(radius >= 0 && radius <= LIMITS.rectRadius)) add('surface-radius', 'FAIL', `surface 第 ${i} 块 radius 需在 0..${LIMITS.rectRadius}：${r.radius}`);
    if (Math.abs(dx) > LIMITS.rectOffset || Math.abs(dy) > LIMITS.rectOffset) add('surface-offset', 'FAIL', `surface 第 ${i} 块偏移上限 ${LIMITS.rectOffset}：dx=${dx} dy=${dy}`);
    const anchor = r.anchor === undefined || r.anchor === null ? '' : String(r.anchor);
    if (anchor !== '' && anchor !== 'top' && anchor !== 'bottom') add('surface-anchor', 'FAIL', `surface 第 ${i} 块 anchor 只能是 "top" 或 "bottom"：${JSON.stringify(r.anchor)}`);
    if (r.maxH !== undefined && !(num(r.maxH) > 0)) add('surface-maxH', 'FAIL', `surface 第 ${i} 块的 maxH 必须是正数或省略：${r.maxH}`);
  });

  return { id, declared, entry, surface, config, hasBackground };
}

function validRelPath(rel) {
  if (!rel || rel.startsWith('/') || rel.includes('\\')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------------------------------------------------------------------------
// 组 2：package（文件真的在不在）
// ---------------------------------------------------------------------------

function checkPackage(report, dir, info) {
  const add = (id, status, message, hint) => report.add('package', id, status, message, hint);
  if (!info?.entry) return;
  const entryPath = join(dir, info.entry);
  if (!existsSync(entryPath)) {
    add('entry-file', 'FAIL', `entry 指向的文件不存在：${info.entry}`, '装上之后宿主会去加载它，404 就是一个空白帧');
    return;
  }
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) add('manifest-file', 'FAIL', '缺少 manifest.json');

  for (const a of Array.isArray(info.assets) ? info.assets : []) {
    if (typeof a === 'string' && !existsSync(join(dir, a))) add('asset-file', 'FAIL', `assets 声明的文件不存在：${a}`);
  }

  // entry 里引用到的本地资源。漏一个的典型症状是"页面能开，但没样式/没脚本"。
  const html = safeRead(entryPath);
  const refs = localRefs(html);
  const missing = refs.filter((ref) => !existsSync(join(dirname(entryPath), ref)));
  for (const ref of missing) {
    add('referenced-file', 'FAIL', `${info.entry} 引用了不存在的文件：${ref}`, '相对路径按 entry 所在目录解析');
  }
  if (refs.length > 0 && missing.length === 0) add('referenced-files-ok', 'PASS', `${refs.length} 个本地引用都能找到`);

  // 「引用了」不等于「会发货」。
  //
  // 打包器只发 panel.html / app.js / style.css 加 manifest.assets。于是"页面引用了、文件也在、
  // 却没写进 assets"这一种资源，在**仓库里一切正常、在装好的插件里不存在**——症状是"页面能开，
  // 样式或脚本没了"，而作者本地永远复现不出来（测试也是按目录读文件的）。
  //
  // 2026-10-30 就是这么漏的：pet-sense / media-sync / weather-env 三个的 panel.html 引用
  // `ui.css`、磁盘上也有 `ui.css`，assets 里却没有它 → 发出去的包里没有那份文件，而三个插件的
  // style.css 里 0 个十六进制色值、9 处 `var(--…)` 全都没有 fallback，于是配色整个空掉。
  const shipped = new Set([
    'panel.html', 'app.js', 'style.css',
    ...(Array.isArray(info.assets) ? info.assets : []).map((a) => String(a).replace(/^\.\//, '')),
  ]);
  const undeclared = refs.filter((ref) => existsSync(join(dir, ref)) && !shipped.has(ref));
  for (const ref of undeclared) {
    add('asset-undeclared', 'FAIL', `${info.entry} 引用了 ${ref}，但 manifest 的 assets 没列它`,
      '打包器只发 panel.html / app.js / style.css 加 assets，其余文件进不了包：装好之后是"页面在、样式没了"。把它加进 assets');
  }
  if (refs.length > 0 && undeclared.length === 0) add('asset-declared-ok', 'PASS', `${refs.length} 个本地引用都会进包`);
}

/** 抽出 HTML 里指向本地的 src/href（跳过 http(s)、data:、#、//）。 */
function localRefs(html) {
  const out = new Set();
  const re = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    out.add(raw.replace(/^\.\//, '').split('?')[0].split('#')[0]);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// 组 3：source（静态文本规则）
// ---------------------------------------------------------------------------

/** 只去掉注释，保留字符串字面量。`request('storage.get')` 的方法名本身就是字符串。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/**
 * 去掉注释与字符串字面量（保留换行，位置大致可用）。
 *
 * 为什么必须有这一步：**注释里常常写着"我们不用 X"**。第一版工具把
 * 「No fetch, no localStorage, no file access」这句注释判成了"用了 localStorage"——
 * 一个把注释当代码的静态检查，比没有检查更坏：它会教人把解释删掉。
 *
 * 代价是会漏掉"字符串里藏着 localStorage"这种形状；那是这个词出现在字符串里的正常用法，
 * 宁可漏也不误报。
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      out += quote === '`' ? '``' : '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function checkSource(report, dir, info) {
  const add = (id, status, message, hint) => report.add('source', id, status, message, hint);

  const jsFiles = [];
  const cssFiles = [];
  walk(dir, (file) => {
    const ext = extname(file).toLowerCase();
    if (ext === '.js' || ext === '.mjs') jsFiles.push(file);
    else if (ext === '.css') cssFiles.push(file);
  });
  if (jsFiles.length === 0) add('js-present', 'WARN', '没有找到 .js 文件', '脚本可以内联在 HTML 里，那样这一组只能检查 HTML');
  if (cssFiles.length === 0) add('css-present', 'WARN', '没有找到 .css 文件', '样式可以内联在 HTML 里');

  const declared = info?.declared ?? new Set();

  // 3.1 方法调用必须在契约表里，且权限已申请
  //
  // 一律在**去掉注释与字符串**之后的文本上做：注释里写着「No fetch, no localStorage」的
  // 插件不该被判成用了 localStorage（第一版就是这么误报的）。
  const called = new Map();
  const strippedJs = new Map();
  for (const file of jsFiles) {
    const raw = safeRead(file);
    strippedJs.set(file, stripCommentsAndStrings(raw));
    collectRequests(stripComments(raw), file, called);
  }
  const html = info?.entry ? safeRead(join(dir, info.entry)) : '';
  const strippedHtml = stripCommentsAndStrings(html);
  collectRequests(stripComments(html), info?.entry ?? 'entry', called);

  if (called.size === 0) {
    add('requests-present', 'WARN', '没有找到任何 request(...) 调用', '一个不调用宿主能力的插件是可能的，但确认一下是不是忘了接线');
  }
  // 动态拼出来的方法名（request(name, …)）静态查不了，只能明确说出来，别假装查过。
  const dynamicAt = called.get(DYNAMIC_METHOD);
  if (dynamicAt) add('command-dynamic', 'WARN', `${dynamicAt} 里有动态拼接的方法名`, '这种调用静态查不到；改成字面量，或者自己写一条协议测试覆盖它');
  let known = 0;
  for (const [method, where] of called) {
    if (method === DYNAMIC_METHOD) continue;
    const spec = METHODS[method];
    if (!spec) {
      add('command-unknown', 'FAIL', `调用了契约里没有的方法 ${method}（${where}）`, '宿主会回「本程序不支持该方法」；方法表见手册第 6/15 节');
      continue;
    }
    known += 1;
    if (!declared.has(spec.perm)) {
      add('command-permission', 'FAIL', `${method} 需要权限 ${spec.perm}，但 manifest 没有申请（${where}）`, '没申请的权限用户不可能授予，这个调用一定被拒');
    }
  }
  if (known > 0) add('commands-known', 'PASS', `${known} 个方法都在契约表里，且权限都已声明`);

  // 3.1.1 存储键的字面量必须是宿主认得的形状
  //
  // 这一条是踩出来的，而且踩了三次：三个不同的插件（pet-sense / media-sync / clipask）都写了
  // `outbox/system.json` 这种"文件名式"的键，宿主一段只收 `[A-Za-z0-9_-]`，于是
  // **整个 storage.get 不执行**（手册 §6.3）。表现是最难查的那种：插件装了、启用了、没有报错，
  // 就是什么都不做——真机上 471 行 `storage key 非法` 全在宿主日志里，界面一片安静。
  //
  // 只查**字面量**：`key: 'outbox/system'` 查得到，`` `s/${hash}/meta` `` 查不到。查不到就说
  // 查不到（这一类交给插件自己的协议测试，比如 qqbot 的 tests/plugin-qqbot-keys.test.js）。
  const KEY_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
  const keyProblem = (key) => {
    if (!key) return '空键';
    if (key.length > 200) return `太长（${key.length} 字符，上限 200）`;
    const segments = key.split('/');
    if (segments.length > 4) return `太深（${segments.length} 段，上限 4）`;
    for (const segment of segments) {
      if (!KEY_SEGMENT.test(segment)) {
        return `第 ${segments.indexOf(segment) + 1} 段 ${JSON.stringify(segment)} 含非法字符`;
      }
    }
    return '';
  };
  const KEY_FIELDS = {
    'storage.get': ['key'], 'storage.set': ['key'], 'storage.remove': ['key'], 'storage.stat': ['key'],
    'storage.dir': ['sub'], 'storage.list': ['sub'], 'storage.move': ['from', 'to'],
  };
  const storageCallRe = /(?:request|call|host\s*\.\s*request)\s*\(\s*['"`](storage\.(?:get|set|remove|stat|dir|list|move))['"`]\s*,\s*\{([\s\S]{0,400}?)\}\s*\)/g;
  const keySources = jsFiles.map((f) => [f, stripComments(safeRead(f))]);
  if (info?.entry) keySources.push([join(dir, info.entry), stripComments(html)]);
  let keysChecked = 0;
  let badKeys = 0;
  for (const [file, text] of keySources) {
    for (const call of text.matchAll(storageCallRe)) {
      for (const field of KEY_FIELDS[call[1]] ?? []) {
        // 只认完整的字面量：带 `${` 的模板串是动态的，静态查不了。
        const found = call[2].match(new RegExp(`${field}\\s*:\\s*['"\`]([^'"\`$]+)['"\`]`));
        if (!found) continue;
        keysChecked += 1;
        const problem = keyProblem(found[1]);
        if (problem) {
          badKeys += 1;
          add('storage-key', 'FAIL',
            `${short(dir, file)} 里 ${call[1]} 的 ${field} ${JSON.stringify(found[1])} 不合法：${problem}`,
            '存储键用 / 分隔、每段只能是字母数字下划线连字符，**不能带扩展名**（手册 §6.3）。不合法时宿主整个请求都不执行：插件会看起来"什么都不做"，只有宿主日志里有一行 WARN');
        }
      }
    }
  }
  // 一条 PASS 只在**没有** FAIL 时打：上面每发现一个非法键就 FAIL 一次，再打一行"都合法"
  // 会让汇总数字读起来像"只有 3 个问题"而 PASS 也有一份，正好把要紧的那行冲淡。
  if (keysChecked > 0 && badKeys === 0) add('storage-key-legal', 'PASS', `${keysChecked} 个字面量存储键都合法`);

  // 3.2 不该碰的浏览器能力
  const banned = [
    [/\blocalStorage\b/, 'localStorage', '帧是 opaque origin，访问会抛 SecurityError；要存东西用 storage.*'],
    [/\bsessionStorage\b/, 'sessionStorage', '同上；用 storage.*'],
    [/\bindexedDB\b/, 'indexedDB', '同上；用 storage.*'],
    [/document\s*\.\s*cookie/, 'document.cookie', '帧没有同源，cookie 不可用；凭据走 net.fetch 的 credentials'],
    [/\bnew\s+WebSocket\s*\(/, 'new WebSocket(...)', '必须经 net.ws：宿主代持连接，白名单与 token 都在那一侧'],
    [/\bnew\s+XMLHttpRequest\s*\(/, 'XMLHttpRequest', '必须经 net.fetch：否则域名白名单形同虚设'],
    [/\bfetch\s*\(\s*['"`]https?:/, "fetch('https://…')", '必须经 net.fetch：跨域请求在这里会被 CORS 挡住，也绕过了白名单'],
  ];
  const scanned = [...strippedJs];
  if (info?.entry) scanned.push([join(dir, info.entry), strippedHtml]);
  for (const [file, text] of scanned) {
    for (const [re, name, hint] of banned) {
      if (re.test(text)) add('banned-api', 'FAIL', `${short(dir, file)} 用了 ${name}`, hint);
    }
  }

  // 3.3 CSS 纪律
  // CSS 也先去注释：样式表里"不许用 box-shadow"这类说明同样会被当成真声明。
  const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  const cssTexts = [...cssFiles.map((f) => [f, stripCss(safeRead(f))]), ...(info?.entry ? [[join(dir, info.entry), stripCss(html)]] : [])];
  // 这条规则只对**声明了浮层面**的插件成立：窗口区域按矩形裁剪，画到盒子外的装饰会被切掉，
  // 在用户桌面上看起来就是"缺了一块"。而一个只在控制中心里铺满面板的插件（没有 surface）活在
  // 一个正常滚动的容器里，卡片阴影与 hover 位移都落在页面内部，不会被裁——对它禁 shadow 只会
  // 逼作者把界面做丑（2026-10-29：三个插件页"特别丑"的一部分原因就是这条被无条件套用）。
  const croppedByRegion = (info?.surface?.length ?? 0) > 0;
  if (croppedByRegion) {
    for (const [file, text] of cssTexts) {
      for (const prop of ['box-shadow', 'filter', 'transform', 'text-shadow']) {
        const re = new RegExp(`(^|[;{\\s])${prop}\\s*:([^;}]+)`, 'gi');
        if (!re.test(text)) continue;
        re.lastIndex = 0;
        let hit;
        while ((hit = re.exec(text))) {
          // `box-shadow: inset …` 画在盒子**里面**，不违反这条规则。
          if (prop === 'box-shadow' && /^\s*inset\b/i.test(hit[2])) continue;
          add('css-forbidden', 'FAIL', `${short(dir, file)} 里有 ${prop}`, '它在矩形之外绘制，会直接画到用户桌面上；用 border / border-radius / 背景色代替');
        }
      }
    }
  }
  const allCss = cssTexts.map(([, t]) => t).join('\n');
  const isSurfacePlugin = (info?.surface?.length ?? 0) > 0;
  if (isSurfacePlugin) {
    if (!/:root[^{]*\{[^}]*background\s*:\s*transparent/i.test(allCss)) {
      add('css-transparent-root', 'WARN', '没有看到 `:root { background: transparent }`', '浮层面矩形里"没画东西"的地方要透出桌面；只在 panel/workshop 挂载的插件可以忽略');
    }
    if (!/color-scheme\s*:\s*only\s+light/i.test(allCss)) {
      add('css-color-scheme', 'WARN', '没有看到 `color-scheme: only light`', 'Chromium 在 color-scheme: dark 下会给画布铺 #121212，:root 的透明压不住它');
    }
  }
  if (/html\[data-theme=["']light["']\]/.test(allCss) && !/get\(\s*['"]theme['"]\s*\)/.test(html)) {
    add('theme-consistency', 'WARN', '样式里有浅色主题，但 entry 没有读地址栏上的 ?theme=', '控制中心首帧会闪一下深色（只影响控制中心；桌宠永远是深色）');
  }

  // 色值只许出现在「调色板」里。
  //
  // 手册 §8.6 的原话是「style.css 里不许出现十六进制色值」。这条对**引了 ui.css 的插件**是硬规则
  // （那个文件就是调色板）。但对**声明了浮层面**的插件，§8.4 又不许它继承 kit 的装饰（阴影/hover
  // 位移会被矩形裁掉），于是它只能自带一份调色板——那种情况下色值出现在 `:root` / `[data-theme]`
  // 块里是**正确**做法，散落在规则里才是错的（同一种颜色会在五处各写一遍，换配色必然漏一处）。
  //
  // 所以这里只报警散落的那一类，而且只 WARN：§8.6 之前写的老插件本来就把颜色写在规则里，把它们
  // 一次判成 FAIL 只会让人关掉这个工具。
  const paletteBlocks = [...allCss.matchAll(/(:root[^{]*|\[data-theme[^\]]*\])\s*\{([^}]*)\}/g)].map((m) => m[2]);
  const paletteNames = new Set(paletteBlocks.join('\n').match(/(--[a-z0-9-]+)\s*:/g) || []);
  // 只看**你自己的**样式表：
  //   - `ui.css` 是宿主那份 kit 的逐字副本（手册 §8.6 规定的名字），它自己的 `.btn.primary` 里就有
  //     `color: #fff`——那正是"调色板所有者"该做的事，不算作者写死颜色；
  //   - entry 那份 HTML 不一定有 CSS，对它报"色值都在调色板里"只是噪音。
  for (const [file, text] of cssFiles.filter((f) => basename(f) !== 'ui.css').map((f) => [f, stripCss(safeRead(f))])) {
    // 把调色板块整块挖掉，剩下的就是"写在规则里的色值"。
    let rest = text;
    for (const block of paletteBlocks) rest = rest.split(block).join('');
    const stray = (rest.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
    if (stray > 0) {
      add('style-hex', 'WARN', `${short(dir, file)} 里有 ${stray} 个十六进制色值写在调色板之外`,
        '色值只该出现在 :root / [data-theme] 的调色板块里（§8.6）。散落在规则里的话，同一个颜色会被写很多遍，换配色必然漏一处；给它起个 --token 名字');
    } else if (paletteNames.size > 0) {
      add('style-palette', 'PASS', `${short(dir, file)} 的色值都在调色板里（${paletteNames.size} 个 token）`);
    }
  }

  // 用了 `var(--x)` 却没有任何地方定义 `--x`。
  //
  // 这条不报错、不警告，浏览器只是让**整条声明**在计算时失效、回落到初始值：
  // `gap: var(--space-2)` → `gap: normal`（0），`padding: var(--space-2) var(--space-3)` → `padding: 0`，
  // `font: var(--font)` → 浏览器默认字体。于是一整页的间距与内边距全部变成 0——文字贴边、按钮挤成
  // 一排，"界面完全不行"，而任何静态检查都不会响。
  //
  // 2026-10-30 实测：clipask 从第一行起就用 `--space-2..5` 与 `--font` 写 gap/padding，而它的
  // `:root` 里一个都没定义。这就是"翻译出来了但界面完全不行"的原因。
  //
  // `var(--x, 4px)` 带兜底值是**合法**用法（那是"可能被外部覆盖"的正常写法），不算漏定义。
  {
    const used = new Set();
    for (const [, text] of cssTexts) {
      for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)) {
        if (!m[2]) used.add(m[1]);
      }
    }
    const defined = new Set();
    for (const m of allCss.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
    const missing = [...used].filter((name) => !defined.has(name)).sort();
    if (missing.length > 0) {
      add('undefined-token', 'FAIL', `用了没定义的自定义属性：${missing.join('、')}`,
        '未定义的 var() 会让整条声明失效并回落到初始值（gap/padding 变 0、font 变默认），页面看起来"排版全塌了"却没有任何报错。在 :root 里定义它们；确实要可选就写成 var(--x, 兜底值)');
    } else if (used.size > 0) {
      add('style-tokens', 'PASS', `用到的 ${used.size} 个自定义属性都有定义`);
    }
  }

  // A surface block is sized by the MANIFEST, not by its content, so content that grows is cut off
  // silently - the card loses its last row and nothing reports it. Only a plugin that measures itself
  // can ask for more room, and the host honours that only for a rect that declares `maxH`. Both
  // halves are checked here because the failure is invisible at runtime (the pomodoro's 2.3.3-2.3.6
  // story: five releases, each diagnosed from a screenshot).
  const surfaceRects = info?.surface?.length ?? 0;
  if (surfaceRects > 0) {
    if (!called.has('surface.blocks')) {
      add('surface-fixed-height', 'WARN', `声明了 ${surfaceRects} 块浮层面，但从不调用 surface.blocks`,
        '卡片高度是声明死的：内容一多就会被裁掉，而且不会报错。内容可能变长就按 scrollHeight 请求高度（surface.blocks 的 sizes），并在矩形里声明 maxH');
    } else if (!(info.surface || []).some((r) => Number(r.maxH) > 0)) {
      add('surface-no-maxh', 'WARN', '调用了 surface.blocks，但矩形里没有声明 maxH',
        '宿主只对声明了 maxH 的块应用 sizes —— 请求会被接受、然后被丢弃（日志里有一条 WARN，调用本身返回成功）');
    }
  }
}

/** 收集 request('method', …) 的调用点。只认字面量方法名，动态拼出来的会漏（记为 WARN）。 */
function collectRequests(text, file, out) {
  // 先去掉 `function request(` 这种**声明**：把它当成调用是第二处误报
  // （todo 插件定义了 `function request(method, payload)`，工具曾据此报"动态方法名"）。
  const calls = text.replace(/\bfunction\s+request\s*\(/g, 'function __decl(');
  const re = /(^|[^.\w$])request\s*\(\s*(['"`])([a-zA-Z0-9_.\-]+)\2/g;
  let m;
  while ((m = re.exec(calls))) {
    if (!out.has(m[3])) out.set(m[3], short('', file));
  }
  if (/(^|[^.\w$])request\s*\(\s*(?!['"`])/.test(calls)) {
    out.set(DYNAMIC_METHOD, short('', file));
  }
}

/** 占位键：表示"这里有个动态拼出来的方法名"。不是真方法名，遍历时要跳过。 */
const DYNAMIC_METHOD = '（动态拼接的方法名）';

/** 插件根目录：entry 所在目录（entry 常常就在根上）。给 "/xxx" 这种绝对引用用。 */
function projectRoot(entryPath) {
  return dirname(entryPath);
}

/**
 * 跑一个相对路径的模块图（只因为 jsdom 不支持 ESM）。
 *
 * 支持的形状：`import * as NS from './x.js'`、`import { a, b as c } from './x.js'`、
 * `import D from './x.js'`；导出支持 `export function/const/let/var/class NAME`、
 * `export default …`、`export { a, b as c }`。遇到裸模块名、动态 import、认不出的形状，
 * 就把原因放进返回值，上层记 SKIP——绝不假装跑过。
 */
function runModuleGraph(window, entryFile) {
  const notes = [];
  const cache = new Map();

  const load = (file) => {
    const abs = resolve(file);
    if (cache.has(abs)) return cache.get(abs);
    const placeholder = {};
    // 先占位：循环 import 时对方拿到的是"还没填满"的对象，而不是无限递归。
    cache.set(abs, placeholder);

    const src = safeRead(abs);
    if (!src) {
      notes.push(`读不到模块 ${short('', abs)}`);
      return placeholder;
    }
    const dir = dirname(abs);
    /** 导出名 → 本模块里的表达式。 */
    const exported = new Map();

    // import … from './x.js'  →  const … = __load('<x.js 的绝对路径>')
    let body = src.replace(
      /^[ \t]*import\s+([^;\n]+?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
      (all, clause, spec) => {
        if (!/^\.{1,2}\//.test(spec)) {
          notes.push(`${short('', abs)} 用了裸模块名 import '${spec}'（宿主的帧里也没有模块解析器）`);
          return '';
        }
        const target = /\.m?js$/.test(spec) ? spec : spec + '.js';
        const call = `__load(${JSON.stringify(join(dir, target))})`;
        let m;
        if ((m = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/))) return `const ${m[1]} = ${call};`;
        if (clause.trim().startsWith('{')) {
          const names = clause.replace(/[{}]/g, '').replace(/\bas\b/g, ':');
          return `const {${names}} = ${call};`;
        }
        const first = clause.split(',')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(first)) return `const ${first} = ${call}.default;`;
        notes.push(`${short('', abs)} 的 import 形状认不出来：import ${clause}`);
        return '';
      },
    );

    body = body.replace(/^([ \t]*)export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (all, indent, asyncKw, name) => {
      exported.set(name, name);
      return `${indent}${asyncKw || ''}function ${name}`;
    });
    body = body.replace(/^([ \t]*)export\s+(const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm, (all, indent, kind, name) => {
      exported.set(name, name);
      return `${indent}${kind} ${name}`;
    });
    body = body.replace(/^([ \t]*)export\s+default\s+/gm, (all, indent) => {
      exported.set('default', '__default');
      return `${indent}const __default = `;
    });
    body = body.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?/gm, (all, names) => {
      for (const part of names.split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        const local = bits[0];
        const name = bits[1] || bits[0];
        if (local) exported.set(name, local);
      }
      return '';
    });

    const fields = [...exported]
      .map(([name, expr]) => `${JSON.stringify(name)}: (typeof ${expr} !== 'undefined' ? ${expr} : undefined)`)
      .join(', ');
    try {
      const factory = new window.Function('__load', `${body}\n;return {${fields}};`);
      Object.assign(placeholder, factory(load) || {});
    } catch (err) {
      notes.push(`${short('', abs)} 求值失败：${String(err?.message || err)}`);
    }
    return placeholder;
  };

  load(entryFile);
  return notes;
}

/**
 * 组 4：把文档真的跑起来。
 *
 * 假宿主的形状照抄真实宿主：收到 `ready` 回一条 `init`，对每个 `request` 回一条 `response`。
 * 每个挂载跑两遍（宿主全部答应 / 全部拒绝），再加一遍 `granted=[]` 与一遍"乱发消息"。
 */
async function checkProtocol(report, dir, info) {
  const add = (id, status, message, hint) => report.add('protocol', id, status, message, hint);
  const { JSDOM } = loadJsdom(dir);
  if (!JSDOM) {
    add('jsdom', 'SKIP', '没有 jsdom：协议那一组跳过', '在插件目录里 `npm i -D jsdom`（或在本工具旁边装）就能跑');
    return;
  }
  if (!info?.entry) return;

  const entryPath = join(dir, info.entry);
  const html = safeRead(entryPath);
  const grantedAll = [...(info.declared ?? [])];

  const mounts = [
    { label: 'panel/workshop', surface: { kind: 'panel', slot: 'workshop' } },
    { label: 'panel/background', surface: { kind: 'panel', slot: 'background' } },
  ];
  if ((info.surface?.length ?? 0) > 0) {
    const r = info.surface[0];
    mounts.push({
      label: 'surface#0',
      surface: {
        kind: 'surface',
        rectIndex: 0,
        rectCount: info.surface.length,
        rect: {
          x: 0, y: 0,
          w: Math.round(Number(r.w) || 0),
          h: Math.round(Number(r.h) || 0),
          r: Math.round(Number(r.radius ?? 0)),
          tailX: 0, hidden: false, room: 160,
        },
      },
    });
  }

  const moduleNotes = new Set();
  // 一个方法只报一次：同一个 workshop 面在 ok / deny 两轮里都会发它，而那是同一个事实。
  const unsupportedSeen = new Set();

  for (const mount of mounts) {
    // 两遍：宿主全部答应、宿主全部拒绝。后者是这套工具最有价值的一条——
    // 它逼出"权限被拒时插件会不会崩"。
    for (const mode of ['ok', 'deny']) {
      const run = await driveOnce({ html, dir, entryPath, mount, mode, granted: grantedAll, info });
      for (const note of run.moduleNotes ?? []) moduleNotes.add(note);
      const tag = `${mount.label}/${mode}`;
      if (run.error) {
        add('boot', 'FAIL', `[${tag}] 文档加载就抛错：${run.error}`, '先修这个，后面所有检查都无从谈起');
        continue;
      }
      if (!run.ready) {
        add('ready', 'FAIL', `[${tag}] 没有发出 {v:1, type:'ready'}`, '监听器装好之后立刻 postMessage 一次；不发 ready 宿主不会回 init');
      } else if (mode === 'ok') {
        add('ready-ok', 'PASS', `[${tag}] 发出了 ready，收到了 init`);
      }
      for (const err of run.errors) add('runtime-error', 'FAIL', `[${tag}] 未捕获错误：${err}`, '宿主拒绝一切时也必须不崩');
      for (const m of run.unknownMethods) add('unknown-method', 'FAIL', `[${tag}] 请求了契约里没有的方法 ${m}`, '宿主会回「本程序不支持该方法」');
      // 「这个窗口没有这个方法」和「契约里没有这个方法」是两件事，而前者以前完全查不出来：
      // 方法表里写着 `where: 'pet'`，却没有任何一处读过它。真机上这一类占了全部 WARN 的一半。
      for (const m of run.unsupported) {
        if (unsupportedSeen.has(m)) continue;
        unsupportedSeen.add(m);
        add('unsupported-here', 'FAIL',
          `[${tag}] 请求了只有桌宠才服务的方法 ${m}`,
          '控制中心给的是 slot:"workshop"，它没有宠物窗口、没有计时器、没有模型预算。按 slot 判断后**不要发这个请求**（手册 §9）：发出去必被拒，而那次拒绝会以一行 WARN 写进宿主日志——每 5 秒一次');
      }
      if (run.badIds.length) add('request-id', 'FAIL', `[${tag}] 有 ${run.badIds.length} 个 request 的 id 不是唯一非空字符串：${run.badIds.slice(0, 3).join(', ')}`, '同一个 id 用两次，第二个 response 会被你当成第一个');
      if (mode === 'ok') {
        if (run.requests.length === 0) add('no-requests', 'WARN', `[${tag}] 握手之后一个 request 都没发`, '纯展示型插件可以忽略；否则说明接线没跑起来');
        else add('boot-ok', 'PASS', `[${tag}] 握手与 ${run.requests.length} 个请求都不崩`);
      } else if (run.errors.length === 0) {
        add('deny-ok', 'PASS', `[${tag}] 宿主拒绝一切时没有崩`);
      }
    }

    // 硬规则：init.granted 是空的，就说明用户什么都没授予；这时不该把请求发出去。
    const strict = await driveOnce({ html, dir, entryPath, mount, mode: 'deny-nothing-granted', granted: [], info });
    for (const note of strict.moduleNotes ?? []) moduleNotes.add(note);
    const ungranted = strict.requests.filter((r) => METHODS[r.method]?.perm);
    if (ungranted.length > 0) {
      const names = [...new Set(ungranted.map((r) => r.method))].slice(0, 4).join(', ');
      // WARN 而不是 FAIL：先发出去、再拿宿主的拒绝文案显示，是合法写法。
      // 要确认的是"界面有没有按 granted 禁用控件"——那件事静态查不到，只能提醒。
      add('ungranted-request', 'WARN', `[${mount.label}] granted=[] 时仍然请求了 ${names}`, '这些调用会被宿主拒绝。如果你依赖它们的成功结果来渲染，界面会停在半截；确认控件也按 granted 禁用了');
    } else {
      add('ungranted-ok', 'PASS', `[${mount.label}] granted=[] 时没有发任何需要权限的请求`);
    }
    for (const err of strict.errors) add('runtime-error-empty-grants', 'FAIL', `[${mount.label}] granted=[] 时抛错：${err}`);
  }

  // 模块加载器的局限要**说出来**：跑不起来的是"没查"，不是"查过没问题"。
  for (const note of moduleNotes) {
    add('module-loader', 'SKIP', `模块图跑不起来：${note}`, '工具的 ESM 加载器只支持相对路径 + 具名/命名空间/默认导出；这种形状请自己补一条测试');
  }

  // 未知消息 / 未来的协议版本 / 主题 / 矩形变化：必须被忽略而不是抛错。
  const tolerant = await driveOnce({ html, dir, entryPath, mount: mounts[0], mode: 'tolerant', granted: grantedAll, info });
  for (const err of tolerant.errors) {
    add('tolerant', 'FAIL', `收到未知/异常消息时抛错：${err}`, '宿主以后会加消息类型；插件应当忽略不认识的 type 与 v≠1');
  }
  if (tolerant.errors.length === 0) add('tolerant-ok', 'PASS', 'theme / surface / 未知 type / v:2 都被安全忽略');
}

/** 把文档跑起来，用假宿主驱动一轮。返回观测到的消息与错误。 */
async function driveOnce({ html, dir, entryPath, mount, mode, granted, info }) {
  const { JSDOM } = loadJsdom(dir);
  const result = { ready: false, gotInit: false, requests: [], errors: [], badIds: [], unknownMethods: [], unsupported: [], error: null };

  // 用 file:// 的 URL 让相对路径的 <script src>/<link> 能被解析（jsdom 会去读盘）。
  let dom;
  try {
    dom = new JSDOM(html, {
      url: pathToFileURL(entryPath).href,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
    });
  } catch (err) {
    result.error = String(err?.message || err);
    return result;
  }
  const { window } = dom;
  const doc = window.document;

  // 假宿主：插件 postMessage 到 window.parent，这里把 parent 指成自己并收消息。
  // 协议本身在 `fake-host.mjs` 里（预览页用的是同一份），这里只提供"怎么把消息送进 window"。
  window.parent = window;

  window.addEventListener('error', (e) => result.errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => result.errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)));

  const host = createFakeHost({
    manifest: info,
    granted,
    surface: mount.surface,
    // 只有 `ok` 那一轮全部答应；其余三轮（`deny` / `granted=[]` / `tolerant`）收到的都是拒绝。
    // 拒绝才是这套工具最有价值的部分——它逼出"权限被拒时插件会不会崩"。
    // 注意 `granted=[]` 那一轮**也**会收到拒绝：要观察的是"它会不会先发出去"，而那件事在
    // 请求到达这里时就已经记下了，回不回都不影响结论；一直不答反而会把插件吊在半路，
    // 让它后面的界面分支根本走不到。
    mode: mode === 'ok' ? 'ok' : 'deny',
    deliver: (data) => {
      const event = new window.MessageEvent('message', { data });
      Object.defineProperty(event, 'source', { value: window });
      window.dispatchEvent(event);
    },
    // 答复由 flush() 逐批送出：有些插件会串行地再发一个请求，立刻回会把时序搅乱。
    autoRespond: false,
  });
  window.postMessage = (msg) => {
    // 握手一到就开始答（不等下面的 sleep）：插件的请求链是"一个答复引出下一个请求"，
    // 早答 90ms 与晚答 90ms 会让观测到的请求条数差一倍。
    if (host.onMessage(msg) === 'ready') flush();
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function flush() {
    for (let round = 0; round < 6; round++) {
      const batch = host.takePending();
      if (batch.length === 0) { await sleep(15); continue; }
      for (const msg of batch) host.respond(msg);
      await sleep(15);
    }
  }

  // 让文档的脚本跑起来（jsdom 的 resources:'usable' 是异步取脚本的）。
  await sleep(60);
  // jsdom 不执行 <script type="module">（它没有 ESM 支持），所以这里自己把相对路径的模块图
  // 跑起来。只支持文档里那种形状；跑不了就把原因记下来，让上层报 SKIP 而不是假装通过。
  const moduleSrc = doc.querySelector('script[type="module"][src]');
  if (moduleSrc) {
    const rel = moduleSrc.getAttribute('src') || '';
    const file = rel.startsWith('/') ? join(projectRoot(entryPath), rel.slice(1)) : resolve(dirname(entryPath), rel.split('?')[0]);
    result.moduleNotes = runModuleGraph(window, file);
  }
  if (mode === 'tolerant') {
    host.send({ v: 1, type: 'theme', theme: 'light' });
    host.send({ v: 1, type: 'surface', rect: { x: 0, y: 0, w: 320, h: 120, r: 12, tailX: 0, hidden: false, room: 160 } });
    host.send({ v: 1, type: 'unknown-message' });
    host.send({ v: 2, type: 'init', surface: mount.surface });
  }
  await sleep(40);
  if (mode === 'ok' || mode === 'deny') await flush();
  // granted=[] 的那一轮不出手：什么都不答，看它会不会在"没被授权"的情况下自己发请求。
  await sleep(80);
  if (dom.window?.close) { try { dom.window.close(); } catch { /* ignore */ } }

  result.ready = host.ready;
  result.gotInit = host.ready; // init 是 ready 的回应，发了就等于收到了 ready
  result.requests = host.requests;
  result.badIds = host.badIds;
  result.unknownMethods = host.unknownMethods;
  result.unsupported = host.unsupported;
  result.errors.push(...host.errors);
  return result;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function safeRead(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function short(dir, file) {
  if (!dir) return file;
  const r = relative(dir, file);
  return r && !r.startsWith('..') ? r : file;
}

function walk(dir, onFile) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, onFile);
    else if (e.isFile()) onFile(full);
  }
}

/** jsdom 是可选的：先看插件自己的依赖，再看本工具旁边。 */
function loadJsdom(dir) {
  for (const base of [dir, process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    try {
      const require = createRequire(join(base, 'noop.js'));
      return { JSDOM: require('jsdom').JSDOM };
    } catch { /* 继续找 */ }
  }
  return { JSDOM: null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const dirs = [];
  const opts = { json: false, only: null };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--only=')) opts.only = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('-')) throw new Error(`未知参数 ${arg}`);
    else dirs.push(arg);
  }
  return { dirs, opts };
}

async function checkOne(dir, opts) {
  const report = newReport(dir);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    report.add('manifest', 'manifest-file', 'FAIL', '目录里没有 manifest.json', '插件的根就是 manifest.json 所在的目录');
    return report;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    report.add('manifest', 'manifest-json', 'FAIL', 'manifest.json 不是合法 JSON：' + String(err?.message || err));
    return report;
  }
  const info = checkManifest(report, manifest);
  if (!info) return report;
  info.assets = Array.isArray(manifest.assets) ? manifest.assets : [];

  const groups = opts.only ?? ['manifest', 'package', 'source', 'protocol'];
  if (groups.includes('package')) checkPackage(report, dir, info);
  if (groups.includes('source')) checkSource(report, dir, info);
  if (groups.includes('protocol')) await checkProtocol(report, dir, info);
  return report;
}

function printReport(report) {
  const dir = report.dir;
  console.log(`\n=== ${dir}`);
  let lastGroup = '';
  for (const c of report.checks) {
    if (c.group !== lastGroup) { console.log(`  [${c.group}]`); lastGroup = c.group; }
    const label = c.status.padEnd(4);
    console.log(`  ${label}  ${c.id}: ${c.message}`);
    if (c.hint && (c.status === 'FAIL' || c.status === 'WARN')) console.log(`          → ${c.hint}`);
  }
  const fails = failCount(report);
  const warns = warnCount(report);
  console.log(`  ${fails === 0 ? 'OK' : 'FAILED'}: ${fails} 个 FAIL, ${warns} 个 WARN, ${report.checks.length} 条检查`);
  return fails;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(String(err.message));
    console.error('用法：node plugin-check.mjs <插件目录> [更多目录…] [--json] [--only=manifest,package,source,protocol]');
    process.exit(2);
  }
  if (args.dirs.length === 0) {
    console.error('用法：node plugin-check.mjs <插件目录> [更多目录…]');
    process.exit(2);
  }

  let totalFails = 0;
  const reports = [];
  for (const raw of args.dirs) {
    const dir = resolve(raw);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      console.error(`${raw} 不是一个目录`);
      totalFails += 1;
      continue;
    }
    const report = await checkOne(dir, args.opts);
    reports.push(report);
    totalFails += failCount(report);
    if (!args.opts.json) printReport(report);
  }

  if (args.opts.json) {
    console.log(JSON.stringify(reports.map((r) => ({ dir: r.dir, checks: r.checks })), null, 2));
  } else {
    console.log(`\n${reports.length} 个插件，${totalFails} 个 FAIL`);
  }
  process.exit(totalFails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('plugin-check 崩了（这是工具自己的 bug，请贴给维护者）：', err);
  process.exit(2);
});
