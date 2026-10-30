import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// QQ 官方机器人插件的**存储键**：一个会话两个键，它们必须是同级的。
//
// 为什么值得单独一个文件：这个 bug 在真机上的样子和它本身毫无关系。原来一个会话用
// `s/<hash>` 存往来、`s/<hash>/meta` 存回复节流——而 `s/<hash>` 是**文件**，它不可能同时是
// 一个目录，于是 `storage.set` 在 mkdir 那一步就失败，报的是 Windows 的
// 「The system cannot find the path specified」（2026-10-29，6 次）。看着像磁盘/权限问题，
// 实际是键设计自撞，而且只在"这个群已经有过往来"之后才发生——所以第一次跑是好的。
//
// 这里钉三件事：两个键同级、都是宿主认得的形状、以及不同会话不互相踩。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-qqbot');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');

// 宿主对存储键的规则（手册 §6.3 / internal/plugins/privatestore.go）：`/` 分隔，最多 4 段，
// 每段 1–64 个 [A-Za-z0-9_-]。这条规则是宿主的，插件只能遵守——所以在这里抄一份**断言**，
// 而不是抄一份实现。
const MAX_DEPTH = 4;
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

function keyProblem(key) {
  if (typeof key !== 'string' || key === '') return '空键';
  const segments = key.split('/');
  if (segments.length > MAX_DEPTH) return `太深：${segments.length} 段`;
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) return `非法段：${JSON.stringify(segment)}`;
  }
  return '';
}

/**
 * Loads lib/core.js into a document built from the plugin's own panel.html, and hands back the
 * three key functions.
 *
 * `new window.Function` rather than `window.eval`: core.js starts with 'use strict', and a
 * STRICT eval gets its own variable environment, so its declarations never reach the global
 * object - `window.flatKey` would be undefined and every assertion below would pass for the
 * wrong reason. Running the source as a function body keeps the same global (`document`
 * resolves) while making the exports explicit.
 */
function loadCore() {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/', runScripts: 'outside-only' });
  const source = readFileSync(path.join(pluginDir, 'lib', 'core.js'), 'utf8');
  const factory = new dom.window.Function(
    `${source}\n;return { flatKey, metaKey, metaKeyForFlat };`,
  );
  return factory();
}

const OPENIDS = [
  '1B2C3D4E5F60718293A4B5C6D7E8F901',
  'A'.repeat(120), // 官方 openid 没有长度承诺，所以键必须先哈希
  '群-带-中文-openid',
];

describe('a session keeps two sibling keys', () => {
  test('the transcript key and the throttling key are both legal storage keys', () => {
    const core = loadCore();
    for (const openid of OPENIDS) {
      for (const key of [core.flatKey(openid), core.metaKey(openid)]) {
        expect(keyProblem(key), `${key} 不是宿主认得的键`).toBe('');
      }
    }
  });

  test('the throttling key is NOT nested under the transcript key', () => {
    // 这就是那个 bug：`s/<hash>` 是文件，`s/<hash>/meta` 要求它是目录。
    const core = loadCore();
    for (const openid of OPENIDS) {
      const transcript = core.flatKey(openid);
      const throttle = core.metaKey(openid);
      expect(throttle.startsWith(`${transcript}/`)).toBe(false);
      expect(transcript.startsWith(`${throttle}/`)).toBe(false);
      expect(throttle).not.toBe(transcript);
    }
  });

  test('the two keys live in different folders, so neither can shadow the other', () => {
    const core = loadCore();
    for (const openid of OPENIDS) {
      const [transcriptDir] = core.flatKey(openid).split('/');
      const [throttleDir] = core.metaKey(openid).split('/');
      expect(transcriptDir).toBe('s');
      expect(throttleDir).toBe('m');
    }
  });

  test('two sessions never share a key, and the same session is stable', () => {
    const core = loadCore();
    const seen = new Set();
    for (const openid of OPENIDS) {
      const transcript = core.flatKey(openid);
      const throttle = core.metaKey(openid);
      expect(core.flatKey(openid)).toBe(transcript);
      expect(core.metaKey(openid)).toBe(throttle);
      for (const key of [transcript, throttle]) {
        expect(seen.has(key), `${key} 被两个会话共用`).toBe(false);
        seen.add(key);
      }
    }
  });

  test('the workshop can rebuild the throttling key from a listed name alone', () => {
    // 工坊页只拿到 storage.list 的扁平名（`<8位哈希>`），没有 openid。所以 core.js 必须
    // 提供一条"从扁平名到同级键"的路，否则清理按钮删不掉节流状态。
    const core = loadCore();
    expect(core.metaKeyForFlat('s/6fc664c3')).toBe('m/6fc664c3');
    for (const openid of OPENIDS) {
      const flat = core.flatKey(openid);
      expect(core.metaKeyForFlat(flat)).toBe(core.metaKey(openid));
    }
  });
});
