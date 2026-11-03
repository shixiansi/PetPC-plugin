// lib/state.js —— 插件唯一的持久状态，一个键。
//
// 为什么不拆成三个键：`unread` / `seen` / `etags` 是同一次轮询里一起变的三样东西，分开写就会
// 出现"记住了看过、但没记住未读"的中间态，而那个态在界面上就是"未读数自己跳了一下"。
// 一次 storage.set = 一次原子写。（手册 §6.3：一个键只有一个写者，这里就是那个写者。）
//
// `seen` 是"同一件事只通知一次"的**硬保证**：宿主今天既不回 ETag、也不让 if-none-match 过闸门，
// 所以条件请求靠不住，按事件 id 记住看过什么才是真正拦住重复的那一层。

'use strict';

const STATE_KEY = 'notify/state';
// 8 个仓库 × 30 条/轮，所以"记住的 id"必须比一轮能抓回来的更多：留 200 条，几轮之内不会
// 把同一条事件当成新动静（约 3 KB，一个键最多 1 MiB）。
const MAX_SEEN = 200;
const MAX_UNREAD = 30;
const MAX_RECENT = 20;

function emptyState() {
  return { seen: [], unread: [], recent: [], etags: {}, lastAt: 0, lastError: '' };
}

function tidyItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id === undefined || raw.id === null ? '' : raw.id);
  if (!id) return null;
  const kind = String(raw.kind || '');
  if (!KIND_LABEL[kind]) return null;
  return {
    id: id,
    repo: String(raw.repo || ''),
    kind: kind,
    title: clampText(raw.title, 100),
    number: Number(raw.number) || 0,
    at: Number(raw.at) || 0,
  };
}

function tidyList(value, limit) {
  const out = [];
  for (const raw of arrayOf(value)) {
    const item = tidyItem(raw);
    if (!item) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 磁盘上的东西可能是上一版写的、也可能被用户手改过，所以每一样都过一遍形状。
 * 读坏不该让插件停摆：看不懂的部分就当没有。
 */
function normalizeState(parsed) {
  const base = emptyState();
  if (!parsed || typeof parsed !== 'object') return base;
  const seen = [];
  for (const raw of arrayOf(parsed.seen)) {
    const id = String(raw === undefined || raw === null ? '' : raw);
    if (id && seen.indexOf(id) < 0) seen.push(id);
    if (seen.length >= MAX_SEEN) break;
  }
  base.seen = seen;
  base.unread = tidyList(parsed.unread, MAX_UNREAD);
  base.recent = tidyList(parsed.recent, MAX_RECENT);
  const etags = parsed.etags && typeof parsed.etags === 'object' ? parsed.etags : {};
  for (const key of Object.keys(etags)) {
    if (typeof etags[key] === 'string' && etags[key]) base.etags[key] = etags[key];
  }
  base.lastAt = Number(parsed.lastAt) || 0;
  base.lastError = clampText(parsed.lastError, 200);
  return base;
}

async function loadState() {
  if (!granted.has('storage')) return emptyState();
  try {
    const out = await request('storage.get', { key: STATE_KEY });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    if (!raw) return emptyState();
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    return emptyState();
  }
}

async function saveState(state) {
  if (!granted.has('storage')) return false;
  const payload = {
    seen: arrayOf(state.seen).slice(0, MAX_SEEN),
    unread: tidyList(state.unread, MAX_UNREAD),
    recent: tidyList(state.recent, MAX_RECENT),
    etags: state.etags && typeof state.etags === 'object' ? state.etags : {},
    lastAt: Number(state.lastAt) || 0,
    lastError: clampText(state.lastError, 200),
  };
  try {
    await request('storage.set', { key: STATE_KEY, value: JSON.stringify(payload) });
    return true;
  } catch (err) {
    // 写不进去（没授权 / 宿主拒绝）不是致命的：这一轮的通知已经发出去了，下一次重新算。
    return false;
  }
}

/** 徽标文案 ≤16 字符（手册 §6.5）。0 条 = 空串，那是"清掉"的意思。 */
function badgeText(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return clampText('GitHub ' + (n > 99 ? '99+' : String(n)), 16);
}
