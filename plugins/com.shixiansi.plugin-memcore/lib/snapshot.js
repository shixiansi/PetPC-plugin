// lib/snapshot.js —— export-state / import-state：记忆的打包与恢复
//
// 快照插件（com.shixiansi.plugin-state-snapshot）要把 memcore 的"当前人设状态"
// 存成档、随时回滚。memcore 的数据全部在自己的私有目录里（mem/role/<会话>/{turns,
// summary,episodes,chain,l3}、mem/user/<用户>/profile、mem/global/chain、
// compact/state），别的插件碰不到——**也不该**让它碰。所以打包与恢复的两侧都在
// memcore 这边做，快照插件只是一个"拿着 JSON 的仓库"：
//
//   export-state  {}  → {version, at, entries: [{key, value}], counts}
//   import-state  {snapshot:{...}} → {restored, removed, counts}
//
// 两个方法都是**整库**操作：export 拿走全部，import 恢复全部——回滚的语义是
// "回到那一刻的样子"，不是"把那一刻合并进来"。import 在恢复前先删掉现有的
// mem/**（global 账本也是快照的一部分：它是"当时发生过什么"的记录）。
//
// 恢复后 memcore 内存里的 cfg 缓存不动（config 是设置不是记忆，快照不背它）。

'use strict';

const SNAPSHOT_VERSION = 1;
const MEM_PREFIX = 'mem/';
const COMPACT_STATE_KEY = 'compact/state';

/** compact/state 的真实键名（lib/compact.js 里是私有常量，这里复制并有一条测试钉住两边）。 */
function compactStateKey() {
  return COMPACT_STATE_KEY;
}

/** 存储键最多 4 段（手册 §6.3），所以递归最多 4 层就到底了。 */
async function collectStateKeys() {
  const keys = [];
  await walkKeys('', keys, 4);
  return keys.filter((k) => k.startsWith(MEM_PREFIX) || k === compactStateKey());
}

/** 从 sub 开始把整个子树列出来（storage.list 不递归，一层层问）。 */
async function walkKeys(sub, keys, depth) {
  if (depth < 0) return;
  const out = await request('storage.list', sub ? { sub } : {}).catch(() => null);
  if (!out) return;
  const files = Array.isArray(out.files) ? out.files : [];
  for (const f of files) {
    if (f && typeof f.name === 'string') keys.push(sub ? `${sub}/${f.name}` : f.name);
  }
  const dirs = Array.isArray(out.dirs) ? out.dirs : [];
  for (const d of dirs) {
    if (typeof d !== 'string' || !d) continue;
    await walkKeys(sub ? `${sub}/${d}` : d, keys, depth - 1);
  }
}

/**
 * `export-state`：把全部分层记忆打包成一个 JSON-safe 对象。
 * 每条 entry 的 value 已经是解析过的对象/数组——落盘由快照插件负责。
 */
async function handleExportState() {
  const keys = await collectStateKeys();
  const entries = [];
  const counts = { roles: 0, users: 0, globalChain: 0, compactState: 0 };
  const roleKeys = new Set();
  const userKeys = new Set();

  for (const key of keys) {
    const raw = await request('storage.get', { key }).catch(() => ({ value: '' }));
    const text = String((raw && raw.value) || '');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    entries.push({ key, value });
    if (key.startsWith('mem/role/')) {
      roleKeys.add(key.split('/')[2]);
      if (key.endsWith('/episodes')) counts.roles += Array.isArray(value) ? value.length : 0;
    } else if (key.startsWith('mem/user/')) {
      userKeys.add(key.split('/')[2]);
    } else if (key === 'mem/global/chain') {
      counts.globalChain = Array.isArray(value) ? value.length : 0;
    } else if (key === compactStateKey()) {
      counts.compactState = 1;
    }
  }
  counts.users = userKeys.size;
  counts.roleSessions = roleKeys.size;

  return {
    version: SNAPSHOT_VERSION,
    at: now(),
    kind: 'memcore-state',
    entries,
    counts: { ...counts, keys: entries.length },
  };
}

/**
 * `import-state`：先清掉现有 mem/**（与 compact/state），再原样写回。
 * payload {snapshot}——快照插件把它存的那份原样递回来。
 * 返回 {restored, removed, counts}。
 */
async function handleImportState(payload) {
  // 两种形状都认：{snapshot: <export 的返回>}（快照插件的存法）与 export 返回值本身。
  // null / 缺 entries 的一律拒绝——见下面"拒绝整库清空"。
  const candidate = payload && typeof payload === 'object' && payload.snapshot && typeof payload.snapshot === 'object'
    ? payload.snapshot
    : (payload && typeof payload === 'object' ? payload : null);
  const snapshot = candidate && (Array.isArray(candidate.entries) || candidate.kind === 'memcore-state') ? candidate : null;
  if (!snapshot) {
    throw new Error('import-state 需要 snapshot（export-state 返回的那一份）');
  }
  if (snapshot.kind && snapshot.kind !== 'memcore-state') {
    throw new Error(`快照类型不对：${snapshot.kind}（要 memcore-state）`);
  }
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  if (!entries.length) throw new Error('快照里没有任何记忆条目（entries 为空）——拒绝整库清空');

  // 1) 清场：mem/** 与 compact/state。
  const existing = await collectStateKeys();
  let removed = 0;
  for (const key of existing) {
    await request('storage.remove', { key }).catch(() => {});
    removed += 1;
  }

  // 2) 原样写回。
  let restored = 0;
  const counts = { roles: 0, users: 0, globalChain: 0, compactState: 0 };
  const roleKeys = new Set();
  const userKeys = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string') continue;
    if (!entry.key.startsWith(MEM_PREFIX) && entry.key !== compactStateKey()) continue;
    const value = entry.value === undefined ? '' : (typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value));
    await request('storage.set', { key: entry.key, value });
    restored += 1;
    if (entry.key.startsWith('mem/role/')) {
      roleKeys.add(entry.key.split('/')[2]);
      if (entry.key.endsWith('/episodes')) {
        const parsed = typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
        counts.roles += Array.isArray(parsed) ? parsed.length : 0;
      }
    } else if (entry.key.startsWith('mem/user/')) {
      userKeys.add(entry.key.split('/')[2]);
    } else if (entry.key === 'mem/global/chain') {
      const parsed = typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
      counts.globalChain = Array.isArray(parsed) ? parsed.length : 0;
    } else if (entry.key === compactStateKey()) {
      counts.compactState = 1;
    }
  }
  counts.users = userKeys.size;
  counts.roleSessions = roleKeys.size;

  return { restored, removed, counts, at: now() };
}
