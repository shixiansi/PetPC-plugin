// lib/snapshots.js —— 快照/回滚的业务编排（plugin.call 的两侧都在这里）
//
//   create：plugin.call('export-state') → SnapStore.save
//   rollback：SnapStore.load → plugin.call('import-state') → 记一条回滚痕迹
//
// 回滚的**顺序**是刻意的：先把快照体完整读出来、校验形状，再让 memcore 清库写回。
// 如果 import 失败（超时、memcore 没在、快照坏），当前记忆**没有被清**——先读后换，
// 失败留在"回滚前"的那一侧。
//
// 回滚痕迹：rollback-log 记录"何时回到了哪个快照"（名字+counts），时间线上会显示。
// 它不是快照——是"这个时间线被改过"的记录。

'use strict';

const MEMCORE = 'com.shixiansi.plugin-memcore';
const ROLLBACK_LOG_KEY = 'state/rollback-log';
const ROLLBACK_LOG_MAX = 30;

const snapshotState = {
  busy: false,
  lastError: '',
  lastRollback: null,
};

/**
 * 做一份新快照。payload {name?}
 * 返回 {entry, evicted?}（entry 是清单条目形状）。
 */
async function handleCreateSnapshot(payload) {
  snapshotState.busy = true;
  snapshotState.lastError = '';
  try {
    const out = await request('plugin.call', { target: MEMCORE, method: 'export-state', payload: {} });
    if (!out || out.kind !== 'memcore-state' || !Array.isArray(out.entries)) {
      throw new Error('记忆核心返回了不认识的快照形状');
    }
    const entry = await SnapStore.save(out, payload && payload.name);
    return entry;
  } catch (err) {
    snapshotState.lastError = `快照没有建成：${text(err && err.message, 140)}`;
    throw err;
  } finally {
    snapshotState.busy = false;
  }
}

/**
 * 回滚到一个快照。payload {id}
 * 返回 {restored, removed, counts, entry}。
 *
 * 快照不存在/坏了 → 抛错，**当前记忆不动**（先读后换）。
 */
async function handleRollback(payload) {
  const id = payload && payload.id;
  snapshotState.busy = true;
  snapshotState.lastError = '';
  try {
    const pack = await SnapStore.load(id);
    if (!pack || !pack.snapshot) {
      throw new Error('快照读不出来（可能已被删除或数据损坏）——当前记忆没有被动过');
    }
    if (pack.kind && pack.kind !== 'memcore-state') {
      throw new Error(`快照类型不对：${pack.kind}——当前记忆没有被动过`);
    }
    const out = await request('plugin.call', { target: MEMCORE, method: 'import-state', payload: { snapshot: pack.snapshot } });
    if (!out || typeof out.restored !== 'number') {
      throw new Error('记忆核心没有确认恢复结果——请检查它的日志，当前状态未知');
    }
    const entry = (await SnapStore.list()).find((one) => one.id === id) || { id, name: '?' };
    const record = {
      at: now(),
      id,
      name: entry.name,
      restored: out.restored,
      removed: out.removed,
      counts: out.counts || {},
    };
    snapshotState.lastRollback = record;
    await appendRollbackLog(record);
    return { ...record, entry };
  } catch (err) {
    snapshotState.lastError = `回滚失败：${text(err && err.message, 140)}`;
    throw err;
  } finally {
    snapshotState.busy = false;
  }
}

/** 回滚痕迹（时间线上显示"何时回到了哪里"）。 */
async function appendRollbackLog(record) {
  try {
    const log = await readJSON(ROLLBACK_LOG_KEY, []);
    const next = (Array.isArray(log) ? log : []).concat([record]).slice(-ROLLBACK_LOG_MAX);
    await writeJSON(ROLLBACK_LOG_KEY, next);
  } catch {
    // 痕迹写不进去不影响回滚本身。
  }
}

async function loadRollbackLog() {
  const log = await readJSON(ROLLBACK_LOG_KEY, []);
  return (Array.isArray(log) ? log : []).slice(-12).reverse();
}

function snapshotSnapshot() {
  return {
    busy: snapshotState.busy,
    lastError: snapshotState.lastError,
    lastRollback: snapshotState.lastRollback,
  };
}
