// qq 的 media 字节预算（plugins/com.shixiansi.plugin-qq/lib/media.js）。
//
// 背景：真机上这个目录长到 497.7 MiB（391 个文件），而宿主上限是 64 MiB —— 于是宿主拒绝写入，
// 插件连 129 字节的账本都存不下去。清单由插件自己守，而这需要一份"谁最旧"的答案：
// `storage.list` 从 2026-10-31 起返回 `modified`。
//
// 这个文件用 new Function 把 lib/media.js 的源码载进来，注入 request/granted/note（插件里由
// app.js / core.js 提供），所以测的是**真正会跑的那份源码**，不是它的复制品。
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-qq');

function loadMedia({ files = {}, granted = ['storage'] } = {}) {
  const source = readFileSync(path.join(pluginDir, 'lib', 'media.js'), 'utf8');
  const removed = [];
  const logs = [];
  const notes = [];
  const request = async (method, payload = {}) => {
    if (method === 'storage.list') {
      const sub = String(payload.sub || '');
      return { dir: 'C:\\模拟\\' + sub, files: (files[sub] || []).map((f) => ({ ...f })), dirs: [] };
    }
    if (method === 'storage.remove') {
      removed.push(String(payload.key));
      return { ok: true };
    }
    if (method === 'plugin.log') {
      logs.push(payload);
      return { ok: true };
    }
    throw new Error('这个测试没有准备 ' + method);
  };
  const note = (text) => notes.push(String(text));
  const expose = new Function(
    'request', 'granted', 'note',
    `${source}\n;return { planEviction, trimMedia, trimMediaAndNote, MEDIA_BUDGET_BYTES, MEDIA_DIRS };`,
  );
  return { api: expose(request, new Set(granted), note), removed, logs, notes };
}

const MiB = 1 << 20;

describe('planEviction（纯函数）', () => {
  test('在预算内一个都不删', () => {
    const files = [{ key: 'media/video/a', bytes: 10 * MiB, modified: 1 }];
    expect(loadMedia().api.planEviction(files, 24 * MiB)).toEqual([]);
  });

  test('超预算时从最旧的删起，删到装得下为止', () => {
    const files = [
      { key: 'media/video/newest', bytes: 8 * MiB, modified: 3000 },
      { key: 'media/video/oldest', bytes: 10 * MiB, modified: 1000 },
      { key: 'media/video/middle', bytes: 10 * MiB, modified: 2000 },
    ];
    // 28 MiB → 预算 24 MiB：删掉最旧的一个（10 MiB）就够了。
    expect(loadMedia().api.planEviction(files, 24 * MiB)).toEqual(['media/video/oldest']);
  });

  test('没有 modified 的排在最前（不知道多旧 = 最可能是遗留物）', () => {
    const files = [
      { key: 'media/video/a', bytes: 10 * MiB, modified: 0 },
      { key: 'media/video/b', bytes: 10 * MiB, modified: 5000 },
      { key: 'media/video/c', bytes: 10 * MiB, modified: 9000 },
    ];
    expect(loadMedia().api.planEviction(files, 20 * MiB)).toEqual(['media/video/a']);
  });
});

describe('trimMedia（对着假的宿主跑）', () => {
  test('只删白名单目录里的文件，数据一个都不碰', async () => {
    const { api, removed } = loadMedia({
      files: {
        // 白名单里的三个目录
        'media/stickers/bytes': [{ name: 'h1', bytes: 20 * MiB, modified: 1000 }],
        'media/video': [{ name: 'v1', bytes: 10 * MiB, modified: 2000 }],
        'media/video/tmp': [],
      },
    });
    const result = await api.trimMedia();
    // 30 MiB → 24 MiB：删最旧的 h1（20 MiB）。
    expect(removed).toEqual(['media/stickers/bytes/h1']);
    expect(result.deleted).toBe(1);
    expect(result.freed).toBe(20 * MiB);
    expect(result.left).toBe(10 * MiB);
  });

  test('预算内一次 storage.remove 都不发', async () => {
    const { api, removed } = loadMedia({
      files: { 'media/video': [{ name: 'v1', bytes: 1 * MiB, modified: 1 }] },
    });
    await api.trimMedia();
    expect(removed).toEqual([]);
  });

  test('没有 storage 权限时什么都不做', async () => {
    const { api, removed } = loadMedia({
      granted: [],
      files: { 'media/video': [{ name: 'big', bytes: 99 * MiB, modified: 1 }] },
    });
    const result = await api.trimMedia();
    expect(removed).toEqual([]);
    expect(result.deleted).toBe(0);
  });

  test('白名单是唯一的来源：目录清单里没有 state/ memory/ 这些', () => {
    const { api } = loadMedia();
    expect(api.MEDIA_DIRS).toEqual(['media/stickers/bytes', 'media/video', 'media/video/tmp']);
    for (const dir of api.MEDIA_DIRS) expect(dir.startsWith('media/')).toBe(true);
  });
});

describe('trimMediaAndNote（说一句，而且只说一次）', () => {
  const overBudget = {
    files: { 'media/video': [{ name: 'v1', bytes: 30 * MiB, modified: 1000 }] },
  };

  test('删了东西就说一句：note + plugin.log 各一条', async () => {
    const { api, notes, logs } = loadMedia(overBudget);
    await api.trimMediaAndNote();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('清理了 media/');
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('info');
    expect(String(logs[0].message)).toContain('预算');
  });

  test('同一个会话里第二次不再吵', async () => {
    const { api, notes, logs } = loadMedia(overBudget);
    await api.trimMediaAndNote();
    await api.trimMediaAndNote();
    expect(notes).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  test('没删东西就一句话都不说', async () => {
    const { api, notes, logs } = loadMedia({
      files: { 'media/video': [{ name: 'small', bytes: 1 * MiB, modified: 1 }] },
    });
    await api.trimMediaAndNote();
    expect(notes).toEqual([]);
    expect(logs).toEqual([]);
  });
});
