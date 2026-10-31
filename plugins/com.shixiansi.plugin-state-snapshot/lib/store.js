// lib/store.js —— 快照库：保存、命名、列表、删除
//
// 快照本体是 JSON 字符串（export-state 的整包），存进自己的私有目录：
//
//   snapshots/index            [{id, name, at, bytes, counts}]  （清单，最旧在前）
//   snapshots/data/<快照id>    快照 JSON 原文
//
// 为什么分两个键：清单每次都要读（时间线渲染），快照体只在回滚时才读——分开之后
// 时间线的成本与快照数量无关。快照 id 是扁平名（时间戳36进制 + 随机尾巴），
// 正好能做存储键的一段。
//
// 容量：maxSnapshots 上限，满了丢最旧的（连清单带数据）。

'use strict';

const SNAP_INDEX_KEY = 'snapshots/index';
const SNAP_DATA_PREFIX = 'snapshots/data/';

const SnapStore = {
  /** 读清单（损坏当空——坏清单不该让时间线消失后无法重建）。
   *  没有 storage 权限就不发请求：granted=[] 的安装里，时间线空着比停在半截好。 */
  async list() {
    if (!granted.has('storage')) return [];
    const saved = await readJSON(SNAP_INDEX_KEY, []);
    return Array.isArray(saved) ? saved : [];
  },

  /** 保存一份快照。返回 {id, name, at, bytes, counts, evicted?}。 */
  async save(snapshot, rawName) {
    const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const name = sanitizeName(rawName) || defaultName(snapshot);
    const json = JSON.stringify({ kind: 'memcore-state', snapshot });
    const bytes = json.length;

    const entry = {
      id,
      name,
      at: Number(snapshot.at) || now(),
      bytes,
      counts: { ...(snapshot.counts || {}) },
    };

    await request('storage.set', { key: `${SNAP_DATA_PREFIX}${id}`, value: json });
    const list = await this.list();
    const next = list.concat([entry]);
    const cap = num('maxSnapshots', 1, 100, 20);

    // 容量：最旧的先走（连数据一起删——留一个清单里的死条目比丢一张旧档更糟）。
    let evicted = null;
    while (next.length > cap) {
      const dead = next.shift();
      await request('storage.remove', { key: `${SNAP_DATA_PREFIX}${dead.id}` }).catch(() => {});
      evicted = dead;
    }
    await writeJSON(SNAP_INDEX_KEY, next);
    return { ...entry, evicted };
  },

  /** 读一份快照的完整 JSON。返回 {kind, snapshot} 或 null。 */
  async load(id) {
    if (!validId(id)) return null;
    try {
      const out = await request('storage.get', { key: `${SNAP_DATA_PREFIX}${id}` });
      const raw = String((out && out.value) || '');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  },

  /** 删除一份（清单 + 数据）。返回是否真的删了清单条目。 */
  async remove(id) {
    if (!validId(id)) return false;
    const list = await this.list();
    const next = list.filter((entry) => entry.id !== id);
    await request('storage.remove', { key: `${SNAP_DATA_PREFIX}${id}` }).catch(() => {});
    if (next.length === list.length) return false;
    await writeJSON(SNAP_INDEX_KEY, next);
    return true;
  },

  /** 给一份快照改名（只改清单；数据不动）。 */
  async rename(id, newName) {
    const list = await this.list();
    const hit = list.find((entry) => entry.id === id);
    if (!hit) return null;
    hit.name = sanitizeName(newName) || hit.name;
    await writeJSON(SNAP_INDEX_KEY, list);
    return hit;
  },
};

/** 存储段的形状约束：快照 id 只允许安全字符。 */
function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function sanitizeName(raw) {
  const cleaned = String(raw === undefined || raw === null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return cleaned;
}

/** 没起名时的默认名：用快照的统计说话。 */
function defaultName(snapshot) {
  const counts = snapshot && snapshot.counts ? snapshot.counts : {};
  const parts = [];
  if (counts.roleSessions) parts.push(`${counts.roleSessions} 会话`);
  if (counts.roles) parts.push(`${counts.roles} 条长期记忆`);
  return parts.length ? `存档（${parts.join('，')}）` : '存档';
}
