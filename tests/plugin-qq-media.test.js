// qq 的私有目录空间管理（plugins/com.shixiansi.plugin-qq/lib/media.js）。
//
// ============================================================================
// 这个文件的每一节都对应一次真机事故，规则是用户定下的：
// ============================================================================
//
//   **表情包是用户主动消费的数据。除非用户自己清，程序在任何时候都不能自动清它。**
//   —— 手工导入的、自动收集的，一视同仁。CDN 链接早已过期，删掉就是永久消失。
//
// 事故时间线（都发生在这台机器上）：
//   2026-10-31 21:59  按 modified 从旧到新删 → 删掉 318 张**手工导入**的图（458 MiB）
//   2026-11-01 15:53  又去删索引里的空记录 → 删掉 318 条识图换来的 tag/描述（28 KB）
//
// 第二条尤其荒谬：28 KB 清不出任何空间，而它销毁的是花钱才得到的元数据。
// 所以现在的 media.js **只有一个可淘汰目录**（视频中间产物），表情包字节连候选都不是。
//
// 这个文件用 new Function 载入 lib/media.js 的真实源码（注入 request/granted/note），
// 所以测的是会跑的那一份，不是复制品。
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
  const DATA = { stickerIndex: 'media/stickers/index' };
  const expose = new Function(
    'request', 'granted', 'note', 'DATA',
    `${source}\n;return { planEviction, trimMedia, trimMediaAndNote, mediaBreakdown, MEDIA_BUDGET_BYTES, EVICTABLE_DIRS, MEDIA_STICKER_DIR };`,
  );
  return { api: expose(request, new Set(granted), note, DATA), removed, logs, notes };
}

const MiB = 1 << 20;

// ---------------------------------------------------------------------------
// 1. 表情包永远不是淘汰候选（用户定下的那条规矩）
// ---------------------------------------------------------------------------

describe('表情包不在淘汰的射程里', () => {
  test('可淘汰目录清单里只有程序自己的中间产物，没有表情包', () => {
    const { api } = loadMedia();
    expect(api.EVICTABLE_DIRS).toEqual(['media/video/tmp']);
    for (const dir of api.EVICTABLE_DIRS) {
      expect(dir, '表情包目录绝不能进可淘汰清单').not.toContain('stickers');
    }
  });

  test('planEviction 对表情包文件返回空计划（哪怕目录传错了）', () => {
    // 即使调用方把表情包文件混进 files，硬过滤也应该拒绝它们——不依赖调用方记得传对。
    const files = [
      { key: 'media/stickers/bytes/aaaa1111', dir: 'media/stickers/bytes', bytes: 40 * MiB, modified: 1 },
      { key: 'media/video/tmp/part1', dir: 'media/video/tmp', bytes: 40 * MiB, modified: 2 },
    ];
    const plan = loadMedia().api.planEviction(files, 24 * MiB, []);
    expect(plan).toEqual(['media/video/tmp/part1']);
  });

  test('trimMedia 一次都不碰表情包目录（连列都不列它）', async () => {
    const { api, removed } = loadMedia({
      files: {
        // 表情包再大也不该被删
        'media/stickers/bytes': [{ name: 'aaaa1111', bytes: 300 * MiB, modified: 1 }],
        'media/video/tmp': [{ name: 'part1', bytes: 30 * MiB, modified: 2 }],
      },
    });
    const result = await api.trimMedia();
    // 只有中间产物被删；表情包那 300 MiB 完好无损。
    expect(removed).toEqual(['media/video/tmp/part1']);
    expect(result.freed).toBe(30 * MiB);
  });

  test('表情包占满全部空间时，节目录里一个文件都不删', async () => {
    const { api, removed } = loadMedia({
      files: { 'media/stickers/bytes': [{ name: 'aaaa1111', bytes: 999 * MiB, modified: 1 }] },
    });
    const result = await api.trimMedia();
    expect(removed).toEqual([]);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 可淘汰部分：只删自己的中间产物
// ---------------------------------------------------------------------------

describe('可淘汰部分的淘汰规则', () => {
  test('在预算内一个都不删', () => {
    const files = [{ key: 'media/video/tmp/a', dir: 'media/video/tmp', bytes: 10 * MiB, modified: 1 }];
    expect(loadMedia().api.planEviction(files, 24 * MiB, [])).toEqual([]);
  });

  test('超预算时从最旧的删起，删到装得下为止', () => {
    const files = [
      { key: 'media/video/tmp/newest', dir: 'media/video/tmp', bytes: 8 * MiB, modified: 3000 },
      { key: 'media/video/tmp/oldest', dir: 'media/video/tmp', bytes: 10 * MiB, modified: 1000 },
      { key: 'media/video/tmp/middle', dir: 'media/video/tmp', bytes: 10 * MiB, modified: 2000 },
    ];
    expect(loadMedia().api.planEviction(files, 24 * MiB, [])).toEqual(['media/video/tmp/oldest']);
  });

  test('没有 storage 权限时什么都不做', async () => {
    const { api, removed } = loadMedia({
      granted: [],
      files: { 'media/video/tmp': [{ name: 'big', bytes: 99 * MiB, modified: 1 }] },
    });
    const result = await api.trimMedia();
    expect(removed).toEqual([]);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 那句话必须只说可淘汰部分（前几版含糊在这里）
// ---------------------------------------------------------------------------

describe('清理后的说明', () => {
  test('删了东西就说一句，并且明说表情包不在此列', async () => {
    const { api, notes, logs } = loadMedia({
      files: { 'media/video/tmp': [{ name: 'v1', bytes: 30 * MiB, modified: 1000 }] },
    });
    await api.trimMediaAndNote();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('中间产物');
    expect(notes[0], '这句话必须让人不用担心自己的图库').toContain('表情包');
    expect(logs).toHaveLength(1);
  });

  test('同一个会话里第二次不再吵', async () => {
    const { api, notes } = loadMedia({
      files: { 'media/video/tmp': [{ name: 'v1', bytes: 30 * MiB, modified: 1000 }] },
    });
    await api.trimMediaAndNote();
    await api.trimMediaAndNote();
    expect(notes).toHaveLength(1);
  });

  test('没删东西就一句话都不说', async () => {
    const { api, notes, logs } = loadMedia({
      files: { 'media/video/tmp': [{ name: 'small', bytes: 1 * MiB, modified: 1 }] },
    });
    await api.trimMediaAndNote();
    expect(notes).toEqual([]);
    expect(logs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. 体检：把"占多少"和"能不能删"分开摆给用户（超额时的决定权交给用户）
// ---------------------------------------------------------------------------

describe('mediaBreakdown（只读体检）', () => {
  test('表情包被标成用户数据，不是可清理', async () => {
    const { api } = loadMedia({
      files: {
        'media/stickers/bytes': [{ name: 'aaaa1111', bytes: 50 * MiB, modified: 1 }],
        'media/video/tmp': [{ name: 'part1', bytes: 5 * MiB, modified: 2 }],
      },
    });
    const rows = await api.mediaBreakdown();
    const stickers = rows.find((row) => row.key === 'media/stickers/bytes');
    expect(stickers).toBeTruthy();
    expect(stickers.grade, '表情包绝不能被标成可清理').toBe('user-data');
    expect(stickers.bytes).toBe(50 * MiB);
    expect(stickers.count).toBe(1);
    const tmp = rows.find((row) => row.key === 'media/video/tmp');
    expect(tmp.grade).toBe('evictable');
  });
});

// ---------------------------------------------------------------------------
// 守门：程序永远不能自动删表情包（用户定下的规矩，静态断言）
// ---------------------------------------------------------------------------
//
// 这条测试不看行为，看**源码形状**：凡是"自动"路径的模块里，不许出现"按预算/上限删表情字节"
// 的写法。行为测试只能覆盖到它想到的场景，静态断言覆盖的是"以后有人又写回一段"。
//
// 允许删除的地方只有两类，而且都必须由**用户那一次操作**直接触发：
//   · importer.js  —— 用户重发同一张图，合并重复条目（同一张图的两份变一份）
//   · workshop.js  —— 用户在工坊里点"删这张 / 清残图"
//   · admin.js / store.js / bili.js —— 群记忆、旧键、视频产物，与表情包无关
//
// 所以下面这份"自动路径"清单里的文件，一个 `stickerBytesKey(...)` 的删除都不许有。
describe('守门：自动路径不许删表情字节', () => {
  const automatic = ['lib/media.js', 'lib/store.js', 'lib/state.js', 'lib/proactive.js', 'lib/memory.js'];
  const decisionFunctions = ['pruneCollected', 'planEviction'];

  test('自动路径里没有任何删表情字节的调用', () => {
    for (const rel of automatic) {
      const src = readFileSync(path.join(pluginDir, rel), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // 判据是"同一个 remove 的参数里出现了表情字节"——整个文件里同时有 remove 和
      // `media/stickers` 不算：media.js 的体检要**统计**表情包大小（只读），那是正当用途。
      const offenders = [];
      const removals = [...code.matchAll(/storage\.remove\s*\(\s*\{[^}]*\}/g)].map((m) => m[0]);
      for (const call of removals) {
        if (/stickerBytesKey|media\/stickers\/bytes/.test(call)) offenders.push(call.trim());
      }
      expect(offenders, rel + ' 里出现了自动删表情包的写法：' + offenders.join(' | ')).toEqual([]);
    }
  });

  test('"满了就删旧的"这类函数不许再出现在任何模块里', () => {
    const files = ['lib/stickers.js', 'lib/media.js', 'lib/store.js', 'lib/state.js'];
    for (const rel of files) {
      const src = readFileSync(path.join(pluginDir, rel), 'utf8');
      // pruneCollected 只允许出现在"它曾经叫这个名字"的注释里；函数定义本身不该有。
      expect(src, rel + ' 又定义了一个会修剪的 pruneCollected').not.toMatch(
        /(async\s+)?function\s+pruneCollected\s*\(/,
      );
    }
  });

  test('自动收集没有任何"满了怎么办"的闸门（不删、也不停）', () => {
    // 两版错法都在这里留下过痕迹：一版"收满就删旧的"，一版"收满就停"。上限本身后来也随
    // 宿主去掉容量限制而失去意义——所以现在这一段**什么闸门都不该有**。
    const src = readFileSync(path.join(pluginDir, 'lib', 'stickers.js'), 'utf8');
    expect(src, '又出现了 canCollectMore 这类"满了就停"的闸门').not.toContain('canCollectMore');
    expect(src, '又出现了"快满了"的字节判断').not.toContain('storageHeadroom');
    // 自动收集函数本身（到下一个顶层函数之前）不许有任何删除。注意范围要收在
    // `collectFromSegments` 里：后面的 `saveCollectedSticker` 会删**待收藏区的暂存**，
    // 那是"已经存进图库了"的那份副本，正当。
    const at = src.indexOf('async function collectFromSegments(');
    const next = src.indexOf('async function ', at + 10);
    const body = src.slice(at, next > at ? next : at + 4000);
    expect(body, '自动收集的路径上出现了删除').not.toMatch(/storage\.remove/);
  });

  test('插件把分级写给宿主，而且表情包永远标 user-data', () => {
    const src = readFileSync(path.join(pluginDir, 'lib', 'media.js'), 'utf8');
    expect(src).toContain("OCCUPANCY_HINTS_KEY = 'occupancy/hints'");
    expect(src).toContain('publishOccupancyHints');
    // 关键断言：不能有任何一个 key 含 stickers 却被标成 evictable。
    const rows = [...src.matchAll(/key:\s*'(media\/stickers[^']*)',\s*grade:\s*'([a-z-]+)'/g)];
    expect(rows.length, '表情包的分级必须显式写出来').toBeGreaterThan(0);
    for (const row of rows) {
      expect(row[2], row[1] + ' 不能标成可清理').toBe('user-data');
    }
  });
});