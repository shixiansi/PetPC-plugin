// lib/store.js —— 那一格状态怎么读、怎么写。
//
// **一个键只有一个写者**这条规则的落地方式：键只有一个（`habits/v1`），但有三个文档会在不同的
// 时刻写它（卡片、插件页、常驻帧）。所以不靠"只让一个角色写"，靠**每次写之前重读一遍**：
// `applyChange()` 是"读 → 结算 → 改一格 → 写"，中间不会有第三个人插进来（一次点击 = 一次往返）。
// 丢掉的那一次更新最多是"两个窗口同时点了同一格"，而那一格的结果是一样的。
//
// 存储键的字面量写在调用点上（而不是只留一个常量）：plugin-check 的 `storage-key` 检查只看得见
// 字面量，写成 `{ key: STATE_KEY }` 就谁也查不到——而键不合法的症状是"整个请求不执行"。

'use strict';

const STATE_KEY = 'habits/v1';

/** 状态读到没有：null 表示"读不到"（没授权 / 宿主拒绝），与"空状态"是两件事。 */
let state = null;

function emptyOrState() {
  return state || emptyState();
}

function parseStored(raw) {
  if (!raw) return emptyState();
  return normalizeState(raw);
}

async function loadState() {
  if (!granted.has('storage')) return null;
  try {
    const out = await request('storage.get', { key: 'habits/v1' });
    return parseStored(out && typeof out.value === 'string' ? out.value : '');
  } catch (err) {
    say('读不到打卡记录：' + (err && err.message ? err.message : err));
    return null;
  }
}

/**
 * 这一次读盘有没有让结算游标往前走（= 有过了一天没落盘）。
 *
 * 常驻帧拿它决定要不要写回去：不写回去的话 `streak` 只在内存里存在，重挂帧之后要靠 60 天的
 * 打卡历史重算，于是"连续 40 天"会在某个普通早晨变成"连续 1 天"。
 */
let lastSettleAdvanced = false;

/** 重新读一次并结算到"今天"。三个角色都用它刷新自己那份内存状态。 */
async function refreshState() {
  const fresh = await loadState();
  if (!fresh) {
    state = state || emptyState();
    lastSettleAdvanced = false;
    return state;
  }
  const settled = settle(fresh, nowMs());
  lastSettleAdvanced = settled.closedThrough !== fresh.closedThrough || settled.streak !== fresh.streak;
  state = settled;
  return state;
}

async function persist() {
  if (!state) return false;
  if (!granted.has('storage')) return false;
  try {
    await request('storage.set', { key: 'habits/v1', value: serializeState(state) });
    return true;
  } catch (err) {
    say('保存失败：' + (err && err.message ? err.message : err));
    return false;
  }
}

/**
 * 读 → 结算 → 改 → 写。`mutate` 收到一份**新鲜**的状态，返回新状态（或 null = 没有改动）。
 *
 * 返回是否真的改了：没改就不写、不重画，"同一格重复点一下"因此完全无声。
 */
async function applyChange(mutate) {
  if (!granted.has('storage')) {
    say('没有「在自己的私有目录里保存数据」这项授权，打卡记不下来');
    return false;
  }
  const fresh = await loadState();
  // 读不回来就什么都不写：`loadState` 已经把宿主的原话放进了状态行。
  if (!fresh) return false;
  const next = mutate(settle(fresh, nowMs()));
  if (!next) return false;
  state = next;
  return persist();
}
