// lib/sampler.js —— outbox 的读法与"什么时候触发 streaming 事件"的判定
//
// 辅助脚本（pet-sense-helper.ps1）把三样东西写进插件私有目录的 outbox/：
//
//   system.json  { cpu, memUsedGb, memTotalGb, memPct, at }
//   load.json    { high, consecutive, cpu, memPct, at }
//   dsh.json     { state, tool, note, at }
//
// 这里只做读与判定，不做任何 I/O 之外的事——判定是纯函数，测试直接调它。
//
// WHY "持续 > 80%" 要在脚本侧判：插件每 1 秒轮询一次文件， if 插件自己判
// "这一秒超没超"，两次轮询之间的高峰就丢了；采样与连续性都在采样者手里，
// 插件只消费"已经判好的事件"，语义才稳定。

'use strict';

/** outbox 里各文件的键。 spelled once：改一处就全改。 */
const FILE_SYSTEM = 'sense/system';
const FILE_LOAD = 'sense/load';
const FILE_DSH = 'sense/dsh';

/** 合法的 DSH 状态：DSH 发别的过来一律丢弃（脚本侧已经挡了一道，这里再挡一道）。 */
const DSH_STATES = ['thinking', 'tool', 'done', 'error'];

/**
 * 把 share.set 的值压成事件（share 值是字符串，≤64KiB；事件都是小对象）。
 * 返回 null = 这条数据不完整/过期，不该发布。
 */
function parseSnapshot(raw, nowMs, maxAgeMs) {
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const at = Number(data.at) || 0;
  if (!at || (typeof nowMs === 'number' && nowMs - at > (maxAgeMs || 30000))) return null; // 过期快照不发
  return data;
}

/**
 * DSH 状态 → 内部事件名。
 *
 * thinking/tool → "思考中/在用工具"（桌宠头顶徽标），done/error → 归档到 share，
 * 由工坊页与订阅方读。返回 null = 不认识的状态（静默丢弃，协议要求的宽容）。
 */
function mapDshState(data) {
  if (!data || typeof data !== 'object') return null;
  const state = String(data.state || '');
  if (!DSH_STATES.includes(state)) return null;
  return {
    kind: `dsh.${state}`,
    tool: String(data.tool || ''),
    note: String(data.note || ''),
    at: Number(data.at) || 0,
  };
}

/** 宠物头顶的徽标文案（pet.badge，≤16 字符）。空串 = 清除。 */
function badgeFor(event) {
  if (!event) return '';
  switch (event.kind) {
    case 'dsh.thinking':
      return '思考中…';
    case 'dsh.tool':
      return event.tool ? `工具:${event.tool}`.slice(0, 16) : '在用工具…';
    case 'load.high':
      return '系统很忙';
    case 'dsh.done':
    case 'dsh.error':
    case 'load.low':
    default:
      return '';
  }
}

/**
 * 负载事件要不要发布：high 的进入（false→true）与离开（true→false）都发，
 * 中间的"仍然高"不重复发——每 5 秒刷一次屏没有信息量。
 */
function shouldPublishLoad(prev, next) {
  const prevHigh = Boolean(prev && prev.high);
  const nextHigh = Boolean(next && next.high);
  return prevHigh !== nextHigh;
}

/**
 * 一次轮询里该做的事，按序返回（测试断言这个顺序）。
 *
 * @param {object} input
 * @param {object|null} input.system  采样快照（有过期判定后的）
 * @param {object|null} input.load    负载事件（脚本侧已判好进/出）
 * @param {object|null} input.prevLoad 上一条已发布的负载事件（edge 检测用）
 * @param {object|null} input.dsh     DSH 状态
 * @param {number} [input.prevDshAt]  上一条已发布的 DSH at（同一条不重发）
 */
function planActions({ system, load, dsh, prevDshAt, prevLoad }) {
  const actions = [];
  if (system) actions.push({ share: FILE_SYSTEM, value: system });
  if (load && shouldPublishLoad(prevLoad, load)) {
    actions.push({ share: FILE_LOAD, value: load });
    const badge = badgeFor({ kind: load.high ? 'load.high' : 'load.low' });
    if (badge) actions.push({ badge });
  }
  if (dsh) {
    const event = mapDshState(dsh);
    if (event && event.at !== (prevDshAt || 0)) {
      actions.push({ share: FILE_DSH, value: dsh });
      actions.push({ badge: badgeFor(event) });
    }
  }
  return actions;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FILE_SYSTEM, FILE_LOAD, FILE_DSH, DSH_STATES, parseSnapshot, mapDshState, badgeFor, shouldPublishLoad, planActions };
}
