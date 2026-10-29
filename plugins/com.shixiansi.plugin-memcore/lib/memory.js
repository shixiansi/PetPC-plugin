// lib/memory.js —— 分层记忆的读写与晋升
//
// 四层 + 两条链，各自的"为什么"写在下面。所有数据都在本插件自己的私有目录里：
//
//   mem/role/<会话>/turns       L1 滚动缓冲：这个会话最近几轮往来（原文）
//   mem/role/<会话>/summary     L2 会话摘要：L1 满了以后压出来的一段话
//   mem/role/<会话>/episodes    L3 情节记忆：值得长期记住的事实/情绪节点
//   mem/role/<会话>/chain       角色工作链：这个会话被激活时用的工作记忆（追加写）
//   mem/user/<用户>/profile     L4 用户画像：跨会话整合出来的偏好/习惯/关系阶段
//   mem/global/chain           全局事件链：所有会话的客观事件，**只写不读**
//
// WHY 全局链不进 prompt
//
// 这正是"两条链"的意义。全局链是一个 append-only 的账本（谁在什么时候说了什么），
// 它保证事件不会因为某个会话被清掉而消失；而**生成**只读当前 roleId 的角色链与其它各层。
// 于是"第三方 QQ 的对话跑进官方 QQ 的上下文里"这种事在结构上就不可能发生——不是靠过滤，
// 而是那条路上的数据根本没有被读过。
//
// WHY 每一层都有上限
//
// 这些东西最后都会拼进 prompt：无上限的积累最终比对话本身还占上下文，而第一个症状是模型
// 对着一墙陈旧笔记回话。满了的处理各不相同：L1 晋升到 L2（它有去处），L3 丢最旧的（一条
// 过期的"他下周考试"没有价值），全局链丢最旧的（它是账本，不是档案）。

'use strict';

const MEM_TURNS = 'turns';
const MEM_SUMMARY = 'summary';
const MEM_EPISODES = 'episodes';
const MEM_CHAIN = 'chain';

/** L1 的上限：一轮往来是两条（user + assistant）。 */
function turnsCap() {
  return num('bufferTurns', 1, 40, 8) * 2;
}

function summaryCap() {
  return num('summaryChars', 120, 2000, 500);
}

function episodesCap() {
  return num('episodeMax', 0, 200, 40);
}

/** 全局账本上限。比任何一个会话都长，但仍然有限：它是一个窗口，不是硬盘。 */
const GLOBAL_CHAIN_CAP = 240;
/** 单个会话的工作链上限。 */
const ROLE_CHAIN_CAP = 80;

function roleKeyOf(roleId) {
  return keyOf(roleId, 'default');
}

function userKeyOf(userId) {
  return keyOf(userId, 'anonymous');
}

function rolePath(roleKey, leaf) {
  return `mem/role/${roleKey}/${leaf}`;
}

// --- L1 / L2 / L3 -------------------------------------------------------------

/** 一个会话的全部状态。四个键一次读齐：少一次 await 就少一个会话内的时序窗口。 */
async function loadRole(roleKey) {
  const [turns, summary, episodes, chain] = await Promise.all([
    readJSON(rolePath(roleKey, MEM_TURNS), []),
    readJSON(rolePath(roleKey, MEM_SUMMARY), null),
    readJSON(rolePath(roleKey, MEM_EPISODES), []),
    readJSON(rolePath(roleKey, MEM_CHAIN), []),
  ]);
  return {
    key: roleKey,
    turns: Array.isArray(turns) ? turns : [],
    summary: summary && typeof summary.text === 'string' ? summary : null,
    episodes: Array.isArray(episodes) ? episodes : [],
    chain: Array.isArray(chain) ? chain : [],
  };
}

async function saveTurns(roleKey, turns) {
  await writeJSON(rolePath(roleKey, MEM_TURNS), turns.slice(-turnsCap()));
}

async function saveSummary(roleKey, summary) {
  await writeJSON(rolePath(roleKey, MEM_SUMMARY), summary);
}

async function saveEpisodes(roleKey, episodes) {
  const cap = episodesCap();
  if (cap <= 0) return;
  await writeJSON(rolePath(roleKey, MEM_EPISODES), episodes.slice(-cap));
}

/**
 * 追加一条工作链事件，并把同一件事记进全局账本。
 *
 * 两处都写、只读一处：这是"隔离但不丢失"的全部实现。append-only 由调用方保证——这里没有
 * 任何删除某一条的路径，只有超长的截断。
 */
async function appendChains(roleKey, event) {
  const chain = await readJSON(rolePath(roleKey, MEM_CHAIN), []);
  const nextChain = (Array.isArray(chain) ? chain : []).concat([event]).slice(-ROLE_CHAIN_CAP);
  await writeJSON(rolePath(roleKey, MEM_CHAIN), nextChain);

  const ledger = await readJSON('mem/global/chain', []);
  const nextLedger = (Array.isArray(ledger) ? ledger : []).concat([event]).slice(-GLOBAL_CHAIN_CAP);
  await writeJSON('mem/global/chain', nextLedger);
}

// --- L4 -----------------------------------------------------------------------

async function loadProfile(userKey) {
  const p = await readJSON(`mem/user/${userKey}/profile`, null);
  if (!p || typeof p !== 'object') return { name: '', prefs: [], habits: [], stage: '', at: 0 };
  return {
    name: typeof p.name === 'string' ? p.name : '',
    prefs: Array.isArray(p.prefs) ? p.prefs.filter((x) => typeof x === 'string') : [],
    habits: Array.isArray(p.habits) ? p.habits.filter((x) => typeof x === 'string') : [],
    stage: typeof p.stage === 'string' ? p.stage : '',
    at: Number(p.at) || 0,
  };
}

async function saveProfile(userKey, profile) {
  await writeJSON(`mem/user/${userKey}/profile`, {
    name: text(profile.name, 40),
    prefs: (profile.prefs || []).slice(0, 12).map((x) => text(x, 80)),
    habits: (profile.habits || []).slice(0, 12).map((x) => text(x, 80)),
    stage: text(profile.stage, 80),
    at: now(),
  });
}

// --- 晋升 ---------------------------------------------------------------------

/**
 * L1 满了没有？满了就返回要被压掉的那一半（最旧的），否则 null。
 *
 * 只在"真的超了"时才返回：一次对话里每一轮都触发摘要不但贵，还会让摘要变成对同一段话的
 * 反复改写。
 */
function overflowOf(turns) {
  const cap = turnsCap();
  if (turns.length <= cap) return null;
  const extra = turns.length - cap;
  return { old: turns.slice(0, extra), keep: turns.slice(extra) };
}

/**
 * 从一段模型输出里取出那个 JSON 对象，取不到返回 null。
 *
 * 宽容在这里是必要的：模型会把 JSON 包进代码块、或者在前后多写一句"好的"，而一次失败的
 * 解析不该让用户丢掉整轮对话。宽容只到"找出第一个 { 到最后一个 }"为止——没有更聪明的猜测。
 */
function parseObject(raw) {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (!body) return null;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 把模型对"压摘要"这一问的回答解析出来。
 *
 * 期望的形状是 {"summary":"…","facts":["…"]}。解析不出来就把整段当成摘要、事实留空——
 * 一次失败的晋升不该让用户丢掉这一轮对话，那才是真正的坏结果。
 */
function parseDigest(raw) {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (!body) return { summary: '', facts: [] };
  const parsed = parseObject(body);
  if (parsed) {
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.filter((x) => typeof x === 'string' && x.trim() !== '')
      : [];
    if (summary || facts.length) {
      return { summary: summary.trim(), facts: facts.map((x) => x.trim()).slice(0, 3) };
    }
  }
  return { summary: body, facts: [] };
}

/** 从一句话里挑一个粗情绪值，只用来决定"这条值不值得晋升"，不参与生成。 */
function valenceOf(line) {
  const sad = /(难过|难受|烦|累|崩溃|失败|吵架|分手|生病|疼|焦虑|害怕|生气)/;
  const glad = /(开心|太好了|谢谢|喜欢|成功|搞定|过了|考上了|升职|高兴|爽|棒)/;
  const s = typeof line === 'string' ? line : '';
  if (sad.test(s)) return -1;
  if (glad.test(s)) return 1;
  return 0;
}

// --- 浏览（workshop 用） --------------------------------------------------------

/** 列出所有记忆目录下的会话键。靠 storage.list 拿到真实的目录，而不是自己猜。 */
async function listRoleKeys() {
  try {
    const out = await request('storage.list', { sub: 'mem/role' });
    const dirs = out && Array.isArray(out.dirs) ? out.dirs : [];
    return dirs.filter((d) => typeof d === 'string' && d !== '');
  } catch {
    return [];
  }
}
