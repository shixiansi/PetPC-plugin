// lib/watcher.js —— 目录轮询与结构索引
//
// chokidar 需要 node 模块，沙箱里没有；宿主也没有"文件系统事件"这种能力。
// 所以监听是**轮询**：每 watchIntervalSec 问一次桥的 /list，与上次的
// {path → mtime} 比对，变了的重读、重解析。对一个开发中的项目，30 秒的
// 粒度完全够用——这不是构建工具，是"桌宠知道你现在在写什么"。
//
// 索引存两份：
//   内存一份（工坊页直接渲染）；
//   storage 一份（state/index，重启后立即可用，不用等第一次扫描）。
//
// 上限就是安全：maxFiles 个文件、maxFileKB 大小——一个 20 万行的生成文件
// 会被跳过而不是把内存吃穿。

'use strict';

const watcher = {
  timer: null,
  scanning: false,
  lastScanAt: 0,
  lastError: '',
  /** path → {structure, mtime, bytes, summary} */
  index: new Map(),
  scanCount: 0,
};

const INDEX_KEY = 'state/index';

function watcherRunning() {
  return Boolean(watcher.timer);
}

/** 扫一次目录。返回 {added, updated, removed, skipped, total}。 */
async function scanOnce() {
  if (watcher.scanning) return { added: 0, updated: 0, removed: 0, skipped: 0, total: watcher.index.size };
  const dir = String(cfg.watchDir || '').trim();
  if (!dir) {
    watcher.lastError = '没有配置要监听的目录';
    return { added: 0, updated: 0, removed: 0, skipped: 0, total: 0 };
  }
  watcher.scanning = true;
  try {
    const files = await bridgeList(dir);
    const maxFiles = num('maxFiles', 1, 2000, 200);
    const maxBytes = num('maxFileKB', 1, 8192, 256) * 1024;
    // 按路径排序后取前 maxFiles：稳定，不依赖桥返回的顺序。
    const picked = files
      .filter((f) => f && typeof f.path === 'string' && /\.(m?js|cjs|ts|jsx|tsx)$/i.test(f.path))
      .sort((a, b) => String(a.path).localeCompare(String(b.path)))
      .slice(0, maxFiles);
    const pickedSet = new Set(picked.map((f) => f.path));

    let added = 0;
    let updated = 0;
    let removed = 0;
    let skipped = 0;

    for (const file of picked) {
      const prev = watcher.index.get(file.path);
      const mtime = Number(file.mtime) || 0;
      const bytes = Number(file.bytes) || 0;
      if (prev && prev.mtime === mtime && prev.bytes === bytes) continue;
      if (bytes > maxBytes) {
        skipped += 1;
        continue;
      }
      const content = await bridgeRead(file.path);
      if (!content) continue;
      const structure = AstParser.parse(content.content, file.path);
      watcher.index.set(file.path, {
        structure,
        mtime,
        bytes,
        summary: AstParser.summarize(structure, 300),
        truncated: content.truncated,
      });
      if (prev) updated += 1;
      else added += 1;
    }

    for (const pathKey of [...watcher.index.keys()]) {
      if (!pickedSet.has(pathKey)) {
        watcher.index.delete(pathKey);
        removed += 1;
      }
    }

    watcher.scanCount += 1;
    watcher.lastScanAt = now();
    watcher.lastError = fileBridge.lastError || '';
    if (granted.has('storage')) void persistIndex();
    return { added, updated, removed, skipped, total: watcher.index.size };
  } finally {
    watcher.scanning = false;
  }
}

function startWatcher() {
  if (watcher.timer) return;
  const everySec = num('watchIntervalSec', 5, 3600, 30);
  void scanOnce();
  watcher.timer = setInterval(() => {
    void scanOnce().catch(() => {});
  }, Math.max(5, everySec) * 1000);
}

function stopWatcher() {
  if (watcher.timer) {
    clearInterval(watcher.timer);
    watcher.timer = null;
  }
}

// --- 索引持久化 -----------------------------------------------------------------

/** 索引落盘：只存摘要与结构（不含源码——源码是用户的东西，不进插件的数据目录）。 */
async function persistIndex() {
  try {
    const entries = [...watcher.index.entries()].slice(0, num('maxFiles', 1, 2000, 200)).map(([pathKey, item]) => ({
      path: pathKey,
      mtime: item.mtime,
      bytes: item.bytes,
      summary: item.summary,
      structure: item.structure,
    }));
    await writeJSON(INDEX_KEY, { at: now(), entries });
  } catch {
    // 索引写不进去 = 下次启动慢一点，不是错误。
  }
}

async function restoreIndex() {
  if (!granted.has('storage')) return;
  const saved = await readJSON(INDEX_KEY, null);
  if (!saved || !Array.isArray(saved.entries)) return;
  for (const entry of saved.entries.slice(0, num('maxFiles', 1, 2000, 200))) {
    if (entry && typeof entry.path === 'string' && entry.structure) {
      watcher.index.set(entry.path, {
        structure: entry.structure,
        mtime: Number(entry.mtime) || 0,
        bytes: Number(entry.bytes) || 0,
        summary: typeof entry.summary === 'string' ? entry.summary : AstParser.summarize(entry.structure, 300),
      });
    }
  }
}

/** 工坊页用的列表（最新的在最上）。 */
function indexList(limit = 40) {
  return [...watcher.index.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([pathKey, item]) => ({
      path: pathKey,
      summary: item.summary,
      lines: item.structure.lines,
      functions: item.structure.functions.length,
      classes: item.structure.classes.length,
      exports: item.structure.exports.length,
      todos: item.structure.todos.length,
    }));
}
