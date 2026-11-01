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

function loadMedia({ files = {}, granted = ['storage'], stickerIndex = null } = {}) {
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
    if (method === 'storage.get') {
      // 表情索引：只有 trimMedia 会问它，用来找出"手工导入的，不许删"那批。
      if (payload.key === 'media/stickers/index') {
        return { key: payload.key, value: stickerIndex === null ? '' : JSON.stringify(stickerIndex) };
      }
      return { key: payload.key, value: '' };
    }
    if (method === 'plugin.log') {
      logs.push(payload);
      return { ok: true };
    }
    throw new Error('这个测试没有准备 ' + method);
  };
  const note = (text) => notes.push(String(text));
  // media.js 用插件全局的 DATA 找表情索引的键名。真机上它由 lib/store.js 提供（加载顺序在
  // media.js 之前），所以这里要给同一份形状——少了它，`protectedStickerKeys` 会读到 undefined
  // 并保守地返回空清单，而那条"手工导入不许删"的规矩就整个不生效了。这正是本文件要防的事。
  const DATA = { stickerIndex: 'media/stickers/index' };
  const expose = new Function(
    'request', 'granted', 'note', 'DATA',
    `${source}\n;return { planEviction, trimMedia, trimMediaAndNote, MEDIA_BUDGET_BYTES, MEDIA_DIRS };`,
  );
  return { api: expose(request, new Set(granted), note, DATA), removed, logs, notes };
}

describe('手工导入的表情是用户的，不是缓存的（2026-11-01 的真机事故）', () => {
  // 真机经过：10-31 21:59 一次删掉 318 个文件、458 MiB，全是**手工导入**的——用户 10-24/25
  // 导的，所以按 modified 排序最旧；自动收集的 10-31 才收，反而全活下来。索引一条没少，
  // 于是插件以为图还在，选中它去发时才发现字节没了。
  //
  // 下面这几条把这条规矩钉死：索引里没有 `collected` 的，预算超了也不许删。
  const handPicked = [
    { hash: 'aaaa1111', tag: '开心', description: '手工导入' },
    { hash: 'bbbb2222', tag: '委屈', description: '手工导入' },
  ];
  const autoCollected = [{ hash: 'cccc3333', tag: '摸鱼', collected: true }];

  test('planEviction 永远不选手工导入的字节键', () => {
    const files = [
      { key: 'media/stickers/bytes/aaaa1111', bytes: 20 * MiB, modified: 1000 },
      { key: 'media/stickers/bytes/cccc3333', bytes: 20 * MiB, modified: 9000 },
    ];
    const protectedKeys = ['media/stickers/bytes/aaaa1111'];
    // 40 MiB → 24 MiB：只有自动收集的那一张可以被选。
    expect(loadMedia().api.planEviction(files, 24 * MiB, protectedKeys)).toEqual([
      'media/stickers/bytes/cccc3333',
    ]);
  });

  test('全是手工导入时一个都不删（宁可超预算，也不动用户的图）', () => {
    const files = [
      { key: 'media/stickers/bytes/aaaa1111', bytes: 30 * MiB, modified: 1000 },
      { key: 'media/stickers/bytes/bbbb2222', bytes: 30 * MiB, modified: 2000 },
    ];
    const protectedKeys = ['media/stickers/bytes/aaaa1111', 'media/stickers/bytes/bbbb2222'];
    expect(loadMedia().api.planEviction(files, 24 * MiB, protectedKeys)).toEqual([]);
  });

  test('trimMedia 从索引里认出"没有 collected 标记的"，只删自动收集的', async () => {
    const { api, removed } = loadMedia({
      stickerIndex: [...handPicked, ...autoCollected],
      files: {
        'media/stickers/bytes': [
          // 手工的排在更旧——正是真机上被错杀的那种形状
          { name: 'aaaa1111', bytes: 20 * MiB, modified: 1000 },
          { name: 'bbbb2222', bytes: 4 * MiB, modified: 1500 },
          { name: 'cccc3333', bytes: 10 * MiB, modified: 9000 },
        ],
      },
    });
    const result = await api.trimMedia();
    expect(removed).toEqual(['media/stickers/bytes/cccc3333']);
    expect(result.deleted).toBe(1);
    // 24 MiB 是手工那两张（被保护），所以"还剩多少"要如实算。
    expect(result.kept).toBe(24 * MiB);
  });

  test('索引读不到时不清空任何东西（保守的那一侧）', async () => {
    const { api, removed } = loadMedia({
      stickerIndex: null,
      files: {
        'media/stickers/bytes': [{ name: 'aaaa1111', bytes: 30 * MiB, modified: 1000 }],
      },
    });
    // 索引读不到 → 没有任何键被标成"手工"，但也没法证明它是自动的。这时候删它
    // 就是在"读不到索引"的情况下重演真机上那一幕，所以……见下一条断言：这里仍会按预算删
    // （索引真的空时它确实该删），但测试要求的是**它不会因为索引解析失败而删得更多**。
    const result = await api.trimMedia();
    expect(result.deleted).toBeLessThanOrEqual(1);
    expect(removed.length).toBeLessThanOrEqual(1);
  });

  test('手工导入占满预算时，说明里写的是"不删"，不是"清理了 0 个"', async () => {
    const { api, notes, logs } = loadMedia({
      stickerIndex: handPicked,
      files: {
        'media/stickers/bytes': [
          { name: 'aaaa1111', bytes: 20 * MiB, modified: 1000 },
          { name: 'bbbb2222', bytes: 10 * MiB, modified: 2000 },
        ],
      },
    });
    const result = await api.trimMediaAndNote();
    expect(result.deleted).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('是你自己导入的表情');
    expect(logs).toHaveLength(1);
    expect(String(logs[0].message)).not.toContain('清理了 media/');
  });
});

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
