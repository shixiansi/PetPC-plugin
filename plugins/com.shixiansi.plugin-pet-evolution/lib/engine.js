// lib/engine.js —— RPG 数值引擎（纯函数：等级曲线 / 经验结算 / 属性点 / 溢出与连升）
//
// 数值体系：
//   满级 100。第 n→n+1 级所需经验 expToNext(n) = floor(20 * n^1.5)（1→2 级 20，
//   10→11 级约 632，99→100 级约 19850）。累计曲线平滑、前期快后期慢。
//   经验来源：互动（喂食/抚摸）、聊天（经 memcore 的对话）、完成任务（外部插件发奖）。
//
// 属性：智力（对话深度）、体力（互动次数上限）、亲密（好感度成长速度）。
//   每级 3 点自由属性点 + 1 点自动给亲密。属性上限 99。
//
// 状态机边界（测试全部钉住）：
//   - 数值溢出：经验/属性写入前 clamp 到安全整数；
//   - 跨级连升：一次结算最多升 20 级（防作弊刷分），溢出的经验保留；
//   - 满级：经验封顶，不再涨；
//   - 版本迁移：SCHEMA_VERSION 递增时按迁移链逐级升级（v1 无属性 → v2 补默认值）。

'use strict';

const SCHEMA_VERSION = 2;
const MAX_LEVEL = 100;
const MAX_STAT = 99;
const MAX_LEVELS_PER_GRANT = 20; // 一次最多连升 20 级（防刷分）
const STATS = ['intellect', 'stamina', 'affinity'];

/** 第 n→n+1 级所需经验。 */
function expToNext(level) {
  if (level >= MAX_LEVEL) return Infinity;
  return Math.floor(20 * Math.pow(level, 1.5));
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 全新存档。 */
function makeProfile() {
  return {
    schema: SCHEMA_VERSION,
    name: '小宠',
    level: 1,
    exp: 0,
    statPoints: 0,
    stats: { intellect: 5, stamina: 5, affinity: 5 },
    friendship: 0, // 好感度：0-100，互动+聊天累积，升级+2
    mood: 'calm',
    unlocked: ['default'], // 已解锁外观
    counters: { chats: 0, plays: 0, tasks: 0, feeds: 0 },
    updatedAt: 0,
  };
}

/** 迁移链：每级迁移器接收旧档，返回新形状。 */
const MIGRATIONS = {
  // v1 → v2：v1 没有属性点与 counters，补默认值；stats 缺哪项补哪项。
  1: (old) => ({
    ...old,
    schema: 2,
    statPoints: Number(old.statPoints) || 0,
    stats: {
      intellect: Number(old.stats && old.stats.intellect) || 5,
      stamina: Number(old.stats && old.stats.stamina) || 5,
      affinity: Number(old.stats && old.stats.affinity) || 5,
    },
    counters: {
      chats: Number(old.counters && old.counters.chats) || 0,
      plays: Number(old.counters && old.counters.plays) || 0,
      tasks: Number(old.counters && old.counters.tasks) || 0,
      feeds: Number(old.counters && old.counters.feeds) || 0,
    },
    unlocked: Array.isArray(old.unlocked) ? old.unlocked : ['default'],
  }),
};

/** 载入任意旧档（包括未来未知版本）：逐级迁移；未知版本按最低已知处理。 */
function migrateProfile(raw) {
  if (!raw || typeof raw !== 'object') return makeProfile();
  let p = JSON.parse(JSON.stringify(raw));
  let v = clampInt(p.schema, 0, SCHEMA_VERSION);
  if (v < 1) {
    // 连 schema 字段都没有的极老档：按 v1 处理再走链。
    p.schema = 1;
    v = 1;
  }
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) break;
    p = step(p);
    v = clampInt(p.schema, v + 1, SCHEMA_VERSION);
  }
  // 兜底清洗：字段缺失补默认（迁移器漏的、手工改坏的）。
  const base = makeProfile();
  for (const key of Object.keys(base)) {
    if (p[key] === undefined) p[key] = base[key];
  }
  p.level = clampInt(p.level, 1, MAX_LEVEL);
  p.exp = Math.max(0, Math.floor(Number(p.exp) || 0));
  p.friendship = clampInt(p.friendship, 0, 100);
  p.statPoints = Math.max(0, Math.floor(Number(p.statPoints) || 0));
  for (const s of STATS) p.stats[s] = clampInt(p.stats[s], 1, MAX_STAT);
  return p;
}

/**
 * 经验结算：返回 {profile, gained:{levels, exp, unlocked}, capped, overflow}。
 * 不改传入对象——返回新对象（存档是唯一真相，结算失败不能写坏它）。
 *
 * @param {object} profile 已迁移的存档
 * @param {number} amount  经验增量（可为负？不行——经验只涨不跌；负数按 0 处理）
 * @param {object} [opts] { maxLevels, now }
 */
function grantExp(profile, amount, opts = {}) {
  const maxLevels = opts.maxLevels || MAX_LEVELS_PER_GRANT;
  const now = opts.now || Date.now();
  const p = JSON.parse(JSON.stringify(profile));
  const add = Math.max(0, Math.floor(Number(amount) || 0));

  if (p.level >= MAX_LEVEL) {
    // 满级：经验封顶、好感照涨。
    p.exp = 0;
    p.friendship = clampInt(p.friendship + 2, 0, 100);
    p.updatedAt = now;
    return { profile: p, gained: { levels: 0, exp: 0, unlocked: [] }, capped: true, overflow: add };
  }

  let pool = p.exp + add;
  if (pool > Number.MAX_SAFE_INTEGER) pool = Number.MAX_SAFE_INTEGER;
  let levels = 0;
  const unlocked = [];
  let overflow = 0;
  while (levels < maxLevels) {
    const need = expToNext(p.level);
    if (pool < need) break;
    pool -= need;
    p.level += 1;
    levels += 1;
    p.statPoints += 3;
    p.friendship = clampInt(p.friendship + 2, 0, 100);
    // 升级解锁外观（每 10 级一个）。
    const skin = `skin-${Math.floor(p.level / 10) * 10}`;
    if (p.level % 10 === 0 && !p.unlocked.includes(skin)) {
      p.unlocked.push(skin);
      unlocked.push(skin);
    }
    if (p.level >= MAX_LEVEL) { pool = 0; break; }
  }
  if (levels >= maxLevels && pool > expToNext(p.level)) {
    overflow = Math.min(pool, Number.MAX_SAFE_INTEGER); // 被连升上限截断的经验
  }
  p.exp = Math.max(0, Math.floor(pool));
  p.updatedAt = now;
  return { profile: p, gained: { levels, exp: add, unlocked }, capped: p.level >= MAX_LEVEL, overflow };
}

/**
 * 分配属性点。返回 {profile, ok, error}。
 * @param {object} profile
 * @param {string} stat 'intellect' | 'stamina' | 'affinity'
 * @param {number} points 正数加、负数减（重分配）
 */
function allocateStat(profile, stat, points) {
  const p = JSON.parse(JSON.stringify(profile));
  if (!STATS.includes(stat)) return { profile, ok: false, error: `未知属性 ${stat}` };
  const n = Math.floor(Number(points) || 0);
  if (n === 0) return { profile, ok: false, error: '分配点数是 0' };
  if (n > 0) {
    if (p.statPoints < n) return { profile: p, ok: false, error: `属性点不够（还剩 ${p.statPoints}）` };
    const room = MAX_STAT - p.stats[stat];
    const actual = Math.min(n, room);
    if (actual <= 0) return { profile: p, ok: false, error: `${stat} 已到上限 ${MAX_STAT}` };
    p.stats[stat] += actual;
    p.statPoints -= actual;
    return { profile: p, ok: true, error: '' };
  }
  // 减点：退回属性点（洗点），属性不低于初始 5。
  const give = Math.min(-n, p.stats[stat] - 5);
  if (give <= 0) return { profile: p, ok: false, error: `${stat} 已在初始值，不能再洗` };
  p.stats[stat] -= give;
  p.statPoints += give;
  return { profile: p, ok: true, error: '' };
}

/** 完整重置属性：全部退回，等级保持（重置不降级，但损失已分配的点变成 statPoints）。 */
function respecStats(profile) {
  const p = JSON.parse(JSON.stringify(profile));
  let returned = 0;
  for (const s of STATS) {
    const over = p.stats[s] - 5;
    if (over > 0) { returned += over; p.stats[s] = 5; }
  }
  p.statPoints += returned;
  return { profile: p, returned };
}

/** 属性效果（给别的系统的接口）：对话深度系数、互动上限、好感倍率。 */
function statEffects(profile) {
  const { intellect, stamina, affinity } = profile.stats;
  return {
    chatDepth: Math.min(4000, 400 + intellect * 36),   // 单次对话上下文预算
    interactionsPerHour: 10 + Math.floor(stamina / 5), // 每小时互动上限
    friendshipRate: 1 + Math.floor(affinity / 20) * 0.1, // 好感成长倍率（1.0-1.4）
  };
}

/** 外观清单：每 10 级一个皮肤 + 里程碑。 */
function skinsForLevel(level) {
  const out = ['default'];
  for (let l = 10; l <= MAX_LEVEL; l += 10) {
    if (level >= l) out.push(`skin-${l}`);
  }
  return out;
}

const EvolutionEngine = {
  SCHEMA_VERSION, MAX_LEVEL, MAX_STAT, MAX_LEVELS_PER_GRANT, STATS,
  expToNext, makeProfile, migrateProfile, grantExp, allocateStat, respecStats,
  statEffects, skinsForLevel, clampInt,
};
