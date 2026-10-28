// lib/memory.js —— 群记忆、群友卡片、社交能量
//
// notes/friends/energy 的读写与注入裁剪。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- 记忆与状态：群记忆、群友卡片、社交能量 ---------------------------------
//
// 这几样都是 aigf 的核心（参考项目叫"四层记忆 + 社交能量"），但它的存储是 .json 文件，
// 我们的是插件的私有 storage —— 形状一样，路径换成键。能用的只有两层：
//
//   memory/<群号>/notes        这个群里值得记住的事（模型自己增删改）
//   memory/friends/<QQ号>      群友卡片（昵称/别名/一句话）
//
// 没有单独的"文化记忆"：梗和网络用语本来就是 notes 的一个分类，多一层只会多一次读写。

/** 一条记忆的注入上限（再长就挤掉 prompt 里的其它段了）。 */
const NOTES_INJECT_CHARS = 600;

function notesKey(groupID) {
  return `memory/${cleanSegment(groupID)}/notes`.slice(0, 64);
}

/**
 * 短期记忆（待办 / 约好的事 / 要问的问题）：和 notes 分开存。
 *
 * 为什么不混进 notes：notes 是"这个群长期成立的事"，会被一直注入；而"记得问他考得怎么样"
 * 这类事做完就该消失，混进去只会让 prompt 越来越长、让模型把旧待办当成新事实。
 */
function todoKey(groupID) {
  return `memory/${cleanSegment(groupID)}/todo`.slice(0, 64);
}

function friendKey(userID) {
  return `memory/friends/${cleanSegment(userID)}`.slice(0, 64);
}

/**
 * 昵称 → QQ 号的索引（一个扁平文件）。
 *
 * 为什么需要它：记忆和待办里提到某个人时写的是**当时的昵称**，而昵称会改。把"叫过的名字"
 * 都记到这张表里，换名之后仍然能找到同一个人（@ 得出来、记忆不会被当成另一个人）。
 */
function friendIndexKey() {
  return 'memory/friends-index';
}

function energyKey(groupID) {
  return `state/energy/${cleanSegment(groupID)}`.slice(0, 64);
}

/** Writes one JSON value, reporting rather than throwing on failure. */
async function writeJSON(key, value) {
  try {
    await request('storage.set', { key, value: JSON.stringify(value) });
    return true;
  } catch (err) {
    note(`写入 ${key} 失败：${(err && err.message) || err}`);
    return false;
  }
}

/** 上限：内存里只留最近 N 条。0 表示关掉群记忆。 */
function notesMax() {
  return number(state.cfg.memoryNotesMax, 20, 0, 120);
}

/** One group's remembered facts. A corrupt file is an empty list, not an error. */
async function loadNotes(groupID) {
  const raw = await readKeyText(notesKey(groupID));
  let parsed = null;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const row of parsed) {
    const text = String((row && row.text) || '').trim();
    if (!text) continue;
    out.push({
      text: text.slice(0, 80),
      // 这条记忆说的是谁（QQ 号）。有了它，昵称改了也认得回同一个人。
      who: cleanSegment((row && row.who) || ''),
      whoName: String((row && row.whoName) || '').slice(0, 20),
      at: Number(row.at) || 0,
    });
  }
  return out;
}

/** 写回本群记忆，超出上限时丢最旧的。 */
async function saveNotes(groupID, rows) {
  const cap = notesMax();
  const capped = cap <= 0 ? [] : rows.slice(-cap);
  await writeJSON(notesKey(groupID), capped);
  return capped;
}

/** 去重用的比较键：前 12 个字。够用，而且不需要分词。 */
function noteKeyOf(text) {
  return Array.from(String(text || '').replace(/\s+/g, '')).slice(0, 12).join('');
}

/**
 * 把模型给的 remember / forget 落到本群**长期**记忆上。
 *
 * `remember` 的每一项可以是字符串，也可以是 `{text, who}`（who 是这句话说的是谁）。带 who 的
 * 会顺手解析成 QQ 号存下来 —— 昵称会改，QQ 不会，这是"换名之后还找得到人"的前提。
 *
 * 去重按"前 12 个字"，因为模型每次复述同一件事时后半句常会变；`forget` 按子串删，
 * 因为模型引用旧条目时原文不一定一字不差。
 */
async function applyMemoryWrites(groupID, { remember = [], forget = [] }) {
  if (!granted.has('storage') || notesMax() <= 0) return { added: 0, removed: 0 };
  if (!remember.length && !forget.length) return { added: 0, removed: 0 };
  const rows = await loadNotes(groupID);
  let kept = rows;
  let removed = 0;
  for (const ref of forget) {
    const key = noteKeyOf(ref);
    const before = kept.length;
    kept = kept.filter((row) => {
      const text = row.text;
      if (ref && text.includes(ref)) return false;
      return !key || !noteKeyOf(text).includes(key);
    });
    removed += before - kept.length;
  }
  let added = 0;
  const now = Date.now();
  const known = new Set(kept.map((row) => noteKeyOf(row.text)));
  for (const item of remember) {
    const raw = typeof item === 'string' ? { text: item } : (item || {});
    const text = stripControl(raw.text || raw.what || raw.fact || '').slice(0, 80);
    const key = noteKeyOf(text);
    if (!key || known.has(key)) continue;
    // 说的是谁：能解析成 QQ 就存 QQ（换名不怕），解析不出就存名字本身。
    const whoRaw = String(raw.who || raw.name || raw.person || '').replace(/^@/, '').trim();
    let who = '';
    let whoName = '';
    if (whoRaw) {
      const resolved = await resolveMention(groupID, whoRaw, '');
      if (resolved && resolved.kind === 'id') {
        who = String(resolved.id);
        whoName = whoRaw.slice(0, 20);
      } else {
        whoName = whoRaw.slice(0, 20);
      }
    }
    known.add(key);
    kept.push(who ? { text, who, whoName, at: now } : { text, at: now });
    added += 1;
  }
  if (added || removed) await saveNotes(groupID, kept);
  return { added, removed };
}

// --- 短期记忆：待办 / 约好的事 ------------------------------------------------

/** 短期记忆最多留多久（过了就当它做完了）。 */
const TODO_TTL_MS = 24 * 3600_000;
/** 短期记忆最多几条。 */
const TODO_MAX = 10;

/** 这个群还没做完的事（过期的当场丢掉）。 */
async function loadTodo(groupID) {
  const raw = await readKeyText(todoKey(groupID));
  let parsed = null;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const now = Date.now();
  const out = [];
  for (const row of parsed) {
    const text = String((row && row.text) || '').trim();
    if (!text) continue;
    const at = Number(row.at) || 0;
    if (at && now - at > TODO_TTL_MS) continue;
    out.push({
      text: text.slice(0, 80),
      who: cleanSegment((row && row.who) || ''),
      whoName: String((row && row.whoName) || '').slice(0, 20),
      at,
    });
  }
  return out;
}

async function saveTodo(groupID, rows) {
  const capped = (rows || []).slice(-TODO_MAX);
  await writeJSON(todoKey(groupID), capped);
  return capped;
}

/**
 * 模型给的 todo / done 落到短期记忆上。
 *
 * `done` 按子串匹配删除：模型引用一条待办时未必一字不差，而"问考得怎么样"和
 * "问他考得怎么样"是同一件事。
 */
async function applyTodoWrites(groupID, { todo = [], done = [] }) {
  if (!granted.has('storage')) return { added: 0, done: 0 };
  if (!todo.length && !done.length) return { added: 0, done: 0 };
  let rows = await loadTodo(groupID);
  let doneCount = 0;
  for (const ref of done) {
    const key = noteKeyOf(ref);
    const before = rows.length;
    rows = rows.filter((row) => {
      if (ref && row.text.includes(String(ref))) return false;
      return !key || !noteKeyOf(row.text).includes(key);
    });
    doneCount += before - rows.length;
  }
  let added = 0;
  const now = Date.now();
  const known = new Set(rows.map((row) => noteKeyOf(row.text)));
  for (const item of todo) {
    const raw = typeof item === 'string' ? { text: item } : (item || {});
    const text = stripControl(raw.text || raw.what || raw.todo || '').slice(0, 80);
    const key = noteKeyOf(text);
    if (!key || known.has(key)) continue;
    const whoRaw = String(raw.who || raw.name || '').replace(/^@/, '').trim();
    const resolved = whoRaw ? await resolveMention(groupID, whoRaw, '') : null;
    const who = resolved && resolved.kind === 'id' ? String(resolved.id) : '';
    known.add(key);
    rows.push({ text, who, whoName: whoRaw.slice(0, 20), at: now });
    added += 1;
  }
  if (added || doneCount) await saveTodo(groupID, rows);
  return { added, done: doneCount };
}

/** One group member's card. */
async function loadFriend(userID) {
  const id = cleanSegment(userID);
  if (!id) return null;
  const raw = await readKeyText(friendKey(id));
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      nickname: String(parsed.nickname || ''),
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases.map(String).slice(-4) : [],
      info: String(parsed.info || ''),
      lastSeenAt: Number(parsed.lastSeenAt) || 0,
      groups: Array.isArray(parsed.groups) ? parsed.groups.map(String).slice(-20) : [],
    };
  } catch {
    return null;
  }
}

/**
 * 系统自动维护的字段：昵称、最后出现时间、在哪些群出现过。
 *
 * 换昵称时把旧昵称收进 aliases —— "它记得我以前叫什么" 是最便宜的一句人味，而且不需要
 * 模型参与。
 */
async function touchFriend(userID, nickname, groupID) {
  const id = cleanSegment(userID);
  if (!id || !granted.has('storage')) return null;
  const card = (await loadFriend(id)) || { nickname: '', aliases: [], info: '', lastSeenAt: 0, groups: [] };
  const name = String(nickname || '').trim().slice(0, 20);
  if (name && name !== card.nickname) {
    if (card.nickname && !card.aliases.includes(card.nickname)) {
      card.aliases = [...card.aliases, card.nickname].slice(-4);
    }
    card.nickname = name;
  }
  card.lastSeenAt = Date.now();
  const gid = cleanSegment(groupID);
  if (gid && !card.groups.includes(gid)) card.groups = [...card.groups, gid].slice(-20);
  await writeJSON(friendKey(id), card);
  // 每次露面都登记一次名字（含刚被替换下来的旧名）：换名之后仍能在这里找到同一个人。
  await rememberAliases(id, [card.nickname, ...card.aliases]);
  return card;
}

/** 模型的 friend 指令：写到发问者（或它指定的 qq）的卡片上。 */
async function applyFriendWrite(askerQQ, askerName, friend) {
  const id = cleanSegment(friend.qq || askerQQ);
  if (!id || !granted.has('storage')) return false;
  const card = (await loadFriend(id)) || { nickname: askerName || '', aliases: [], info: '', lastSeenAt: 0, groups: [] };
  if (friend.nickname) card.nickname = friend.nickname;
  else if (askerName && !card.nickname) card.nickname = askerName;
  for (const alias of friend.aliases) {
    if (alias && !card.aliases.includes(alias)) card.aliases.push(alias);
  }
  card.aliases = card.aliases.slice(-4);
  if (friend.info) card.info = friend.info;
  card.lastSeenAt = Date.now();
  await writeJSON(friendKey(id), card);
  await rememberAliases(id, [card.nickname, ...card.aliases]);
  return true;
}

/**
 * 昵称/别名 → QQ 号的索引。一张扁平表，键是小写名字。
 *
 * 写卡片时顺手登记；`resolveMention` 认不出名字时来这张表里查。用一张表而不是每次翻所有
 * 卡片：一个群几十号人，翻卡片是几十次读，而这张表是一次。
 */
async function rememberAliases(userID, names) {
  const id = cleanSegment(userID);
  if (!id || !granted.has('storage')) return;
  const list = (names || []).map((name) => stripControl(name)).filter(Boolean);
  if (!list.length) return;
  let index = {};
  try {
    const parsed = JSON.parse((await readKeyText(friendIndexKey())) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) index = parsed;
  } catch {
    index = {};
  }
  let changed = false;
  for (const name of list) {
    const key = name.toLowerCase();
    if (index[key] === id) continue;
    index[key] = id;
    changed = true;
  }
  if (changed) await writeJSON(friendIndexKey(), index);
}

/** 名字（含旧昵称/别名）→ QQ 号；查不到返回空串。 */
async function resolveAlias(name) {
  const key = stripControl(name).toLowerCase();
  if (!key || !granted.has('storage')) return '';
  try {
    const index = JSON.parse((await readKeyText(friendIndexKey())) || '{}');
    const id = index && typeof index === 'object' ? index[key] : '';
    return cleanSegment(id || '');
  } catch {
    return '';
  }
}

/** 能量基线（配置用 0-100 的整数，内部用 0-1）。 */
function energyBaseline() {
  return number(state.cfg.energyBaseline, 70, 0, 100) / 100;
}

/**
 * 把 0-1 的能量翻译成一句"状态"。
 *
 * 这段话是给模型看的，所以写的是**行为**而不是数字："不想说话，可以只回一个嗯"
 * 比 "energy=0.12" 有用得多。
 */
function energyLabel(value) {
  if (value >= 0.8) return '精力充沛，看到什么都想插一句';
  if (value >= 0.6) return '状态不错，有兴趣的话题会主动搭话';
  if (value >= 0.4) return '一般般，有人找就回，不太主动';
  if (value >= 0.2) return '有点懒，能一个字回就不写一句';
  return '不想说话，只想潜水；被点名也可以只敷衍两个字，或者干脆不说话';
}

async function loadEnergy(groupID) {
  const raw = await readKeyText(energyKey(groupID));
  try {
    const parsed = JSON.parse(raw || '{}');
    const value = Number(parsed && parsed.value);
    if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  } catch {
    /* 坏值回落到基线 */
  }
  return energyBaseline();
}

async function saveEnergy(groupID, value) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0));
  await writeJSON(energyKey(groupID), { value: Math.round(clamped * 1000) / 1000, at: Date.now() });
  return clamped;
}

/**
 * 每条消息都先"恢复一点能量"。
 *
 * 向基线回归 + 一点随机漂移，被 @ 额外加成：这形成一个"话多→累了→安静→恢复"的周期，
 * 而不是一个恒定的回复率。参考项目（aigf）的社交能量就是这么做的。
 */
async function settleEnergy(groupID, mentioned) {
  if (!granted.has('storage')) return energyBaseline();
  const current = await loadEnergy(groupID);
  const base = energyBaseline();
  let next = current + (base - current) * 0.25 + (Math.random() - 0.5) * 0.16;
  // 被 @ 的加成必须**小于**一次回复的成本：真机上 0.1 的加成对上 0.03 的成本，结果是能量
  // 一路顶到 97，社交能量退化成装饰。0.05 配上 0.05 的底成本，长回复才真的让"它累了"。
  if (mentioned) next += 0.05;
  return saveEnergy(groupID, next);
}

/**
 * 给一条消息贴个表情回应（`send_group_message_reaction`），一个字都不发。
 *
 * 用途："被 @ 了但选择沉默"。原来这种时候群里**一点反应都没有**，看起来就是坏了；
 * 而回一句话又违背了"这次不想说"。贴个表情正好：看见了，但没什么要说的。
 *
 * `reaction` 是 QQ 表情 id，`14` 是经典「微笑」——看见了、但不打算多聊，语气刚好。
 * 协议端不认这个 id 时只记一行日志（不会刷屏），功能等同于"没有反应"。
 */
const SILENT_REACTION_FACE = '14';

async function reactToMessage(groupID, messageSeq) {
  const seq = Number(messageSeq);
  if (!Number.isFinite(seq) || seq <= 0) return false;
  if (!granted.has('net.fetch')) return false;
  try {
    await api('send_group_message_reaction', {
      group_id: Number(groupID),
      message_seq: seq,
      reaction: SILENT_REACTION_FACE,
      reaction_type: 'face',
      is_add: true,
    });
    return true;
  } catch (err) {
    if (!state.unknownEvents.has('message_reaction')) {
      state.unknownEvents.add('message_reaction');
      note(`给消息贴表情失败（reaction=${SILENT_REACTION_FACE}）：${(err && err.message) || err}`);
    }
    return false;
  }
}

/** 说完一句之后扣能量：基础 0.05，按字数最多再加 0.15。 */
async function spendEnergy(groupID, chars, delta) {
  if (!granted.has('storage')) return energyBaseline();
  const current = await loadEnergy(groupID);
  const cost = 0.05 + Math.min(0.15, Math.max(0, chars) / 2000);
  return saveEnergy(groupID, current - cost + (Number.isFinite(delta) ? delta : 0));
}

/** 不说话时只应用模型自己的能量调整。 */
async function adjustEnergy(groupID, delta) {
  if (!Number.isFinite(delta) || !delta) return;
  if (!granted.has('storage')) return;
  const current = await loadEnergy(groupID);
  await saveEnergy(groupID, current + delta);
}

/**
 * 正文里出现图库编号时，把它当成"要发这张图"。
 *
 * 真机上连着撞到两次：群里出现整行的 `694ee580`，然后是一句 `给你这个，5f5910ea。`
 * —— 模型把候选列表里的编号写进了正文，而编号只该出现在围栏的 `meme` 里。
 *
 * 判据是"这个编号**真的在图库里**"（8 位十六进制 + 图库命中）：
 *   · 命中 → 从正文里摘掉它（连同紧挨着的标点），返回 `{text:…, meme:<id>}`，图由调用方发；
 *   · 整条就是编号但图库里没有 → 清空正文（往群里发一串十六进制比沉默更糟）；
 *   · 句子里有别的十六进制但不是图库里的 → 原样放行，别吃掉正常的话。
 */
async function absorbStickerIdText(groupID, say) {
  const text = String(say || '');
  const tokens = text.match(/\b[0-9a-f]{8}\b/gi) || [];
  if (!tokens.length) return { text: say };
  let known = new Map();
  try {
    const index = await loadStickerIndex();
    known = new Map((index || [])
      .filter((row) => row && row.hash)
      .map((row) => [String(row.hash).toLowerCase(), row]));
  } catch {
    known = new Map();
  }
  const hit = tokens.map((token) => token.toLowerCase()).find((token) => known.has(token));
  if (!hit) {
    const onlyToken = tokens.length === 1 && text.trim().toLowerCase() === tokens[0].toLowerCase();
    if (!onlyToken) return { text: say };
    note(`群 ${groupID}：模型把表情编号当正文了（${tokens[0]}），但图库里没有这张，这次不发`);
    return { text: '' };
  }
  const rest = text
    .replace(new RegExp(`[，,、；;:：]*\\s*\\b${hit}\\b\\s*`, 'i'), '')
    .replace(/[，,、；;:：]+(?=[。.!！?？]|$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  note(`群 ${groupID}：正文里带了表情编号（${hit}），改成发那张图`);
  return { text: rest, meme: known.get(hit).hash };
}

/**
 * 发一张表情。`meme` 是模型挑出来的 id（优先），`tag` 是它的老写法（情绪标签）。
 *
 * 四道闸，每一道都必要：`stickerChance` 为 0 就是"不要发表情"（硬开关）、每群冷却、
 * 模型挑的 id 必须真的在图库里、挑不到再退回按标签随机。失败只记一行日志——一条没配
 * 表情的回复不算错误。
 *
 * 与 1.11 的区别：**模型给具体 id 时不再掷骰子**。`stickerChance` 是给"按标签随机"
 * 那条路用的；模型明确挑了某一张，那就是它的决定，再用概率砍一半只会让人纳闷
 * "它明明选了为什么不发"。冷却仍然生效，它管的是"别刷屏"。
 */
async function maybeSendSticker(groupID, meme, tag) {
  const wanted = cleanSegment(meme || '');
  if (!wanted && !tag) return;
  const chance = number(state.cfg.stickerChance, 30, 0, 100);
  // 每一道闸都在日志里报自己的名字：否则"回了话但从不发表情"无法诊断。
  if (chance <= 0) {
    note(`这次不发表情：配表情的概率是 0（群 ${groupID}）`);
    return;
  }
  const now = Date.now();
  const gap = number(state.cfg.stickerCooldownSec, 120, 0, 86400) * 1000;
  const lastAt = state.lastStickerAt.get(groupID) || 0;
  if (now - lastAt < gap) {
    const left = Math.max(1, Math.ceil((gap - (now - lastAt)) / 1000));
    note(`这次不发表情：还在冷却里，还要等 ${left} 秒（群 ${groupID}）`);
    return;
  }

  let picked = null;
  let index = null;
  if (wanted) {
    index = await loadStickerIndex();
    picked = await stickerByID(index, wanted);
    if (!picked) note(`这次不发表情：模型挑的 ${wanted} 不在图库里（群 ${groupID}）`);
  }
  if (!picked && tag) {
    if (chance < 100 && Math.random() * 100 >= chance) {
      note(`这次不发表情：概率没中（群 ${groupID}，配表情概率 ${chance}%）`);
      return;
    }
    if (!index) index = await loadStickerIndex();
    picked = await pickStickerForTag(tag, stickerLibrary(), index);
    if (!picked) note(`这次不发表情：图库里没有「${tag}」分类的表情（群 ${groupID}）`);
  }
  if (!picked) return;

  state.lastStickerAt.set(groupID, now);
  try {
    await api('send_group_message', {
      group_id: Number(groupID),
      message: [{
        type: 'image',
        data: { uri: picked.uri, sub_type: 'sticker', summary: `[表情：${picked.tag || tag || ''}]` },
      }],
    });
    state.counts.replies += 1;
    note(`在群 ${groupID} 发了一张表情（${picked.tag || tag || '未分类'}，来源:${picked.kind}）`);
  } catch (err) {
    note(`表情发送失败：${(err && err.message) || err}`);
  }
  // 使用次数只在真的发出去之后加：这个计数决定"下次优先挑哪张"，被拒的那次不该算。
  if (picked.hash && Array.isArray(index)) await bumpStickerUsage(index, picked.hash);
}

/**
 * The persona used when the user has not written one.
 *
 * It says "a regular in this group", NOT "a robot that chats in a QQ group". That
 * wording is load-bearing: a model told it is a robot writes like one - "作为一个
 * AI…", "有什么可以帮你的" - and that is the single most recognisable tell in a group.
 * It invents no character either; anyone who wants one writes their own, which
 * replaces this line entirely.
 */
const DEFAULT_PERSONA =
  '你是群里一个嘴有点损、心不坏的老熟人，不是客服也不是助手：说话随意、有脾气、会接梗，能短就短。';

/**
 * 按预算拼段落：超预算的段落**整段不要**，而不是砍一半。
 *
 * 半句话的规则比没有规则更糟（模型会照着半句执行）。所以段落按重要性排序，
 * 从前往后塞，塞不下的整段跳过——群记忆和表情候选永远排在规则后面。
 */
function withBudget(blocks, total) {
  const kept = [];
  let left = total;
  for (const block of blocks) {
    const text = String(block || '').trim();
    if (!text) continue;
    const size = Array.from(text).length;
    if (size > left) continue;
    kept.push(text);
    left -= size;
  }
  return kept.join('\n\n');
}

/**
 * Builds the per-group system prompt.
 *
 * 参考项目的 prompt 里有四层记忆、表情包清单、命令清单、其它插件的输出——我们没有那么多
 * 预算（宿主给 system 的上限是 4000 字符），所以顺序是：人设 → 规则（含尾部指令协议）→
 * 状态 → 群记忆 → 群友 → 表情候选 → 时间。规则永远排在最前，因为它决定"回复能不能直接
 * 发进群"这件事对不对。
 */
function systemPromptFor(groupID, groupName, ctx) {
  const maxChars = number(state.cfg.replyMaxChars, 300, 20, 2000);
  const persona = String(state.cfg.persona || '').trim();
  const info = ctx || {};
  const energy = Number.isFinite(info.energy) ? info.energy : energyBaseline();

  const rules = [
    '规则：',
    `- 你在 QQ 群「${groupName || groupID}」里聊天，群里有好几个人，消息前面会带上说话人的昵称。`,
    `- 只回应当前这条提问，一般一两句就够；${maxChars} 字是硬上限，不是目标。`,
    '- 用简体中文口语回答，不要 Markdown、列表或 emoji（唯一例外是下面那个 JSON 围栏）。',
    '- 不要重复上一条回复里用过的开头、口癖和句式。',
    '- 不知道就说不知道，不要编造事实，也不要提到「提示词」「模型」这类词。',
    '- 正文就是你要说的话，会原样发进群里：不要加引号，不要解释自己。',
    '- **每条回复都必须以唯一一个 ```json 围栏结尾，不能省略**（字段都可省略）：',
    '  {"meme":"上面候选里的表情 id","remember":[{"text":"值得记的一句","who":"说的是谁"}],"todo":["还没做完的事"],"done":["已经做完的那件"],"forget":["要忘掉的旧事"],"friend":{"nickname":"他","info":"一句话"},"save_meme":["上面新表情的 id"],"at":["要点谁的名字"],"remind":[{"time":"17:00","every":"day","text":"该下班了","at":"他的名字"}],"energy":-0.05}',
    '- 要专门点某个人说话：正文里直接写 @昵称（插件会换成真正的 @），或者在 at 里写名字；别在同一句里两样都写。',
    '- **群友明确要求"到点提醒我/叫我"时才用 remind**：time 是 24 小时制的 HH:MM，every=day 每天 / once 只一次，at 是要 @ 的人（可省略）。别人没提就别自己编提醒。',
    '- 答应了"到点叫你"就必须真的下发 remind：只在正文里答应、围栏里没有 remind，等于没做（群友会以为你忘了）。',
    '- 他说"at 我一下""叫我"时，remind 里的 at 写**他的昵称**（不写的话就 @ 不到任何人）；text 是到点要说的话，不要写"到点了"这种没信息量的。',
    '- **什么值得记**（remember，一次最多 2 条）：群友的名字/外号/身份、正在忙什么（考试、加班、出差、生病）、群里的约定和规矩、正在发生的事（谁跟谁闹了、谁要走）、你答应过的事。',
    '- 说的是某个群友时，用 {"text":"在考研","who":"他的昵称"} 这种形状，把人和事绑在一起（昵称会改，绑定之后仍认得出来）。',
    '- **长期和短期分开**：上面那些"一直成立的事"用 remember；**一次性的待办、约好的事、要问的问题**用 todo——比如"记得问他考得怎么样""明天他生日"。做完/问过了就用 done 写一句把它消掉。todo 最多 10 条、24 小时后自动忘掉。',
    '- 待办和约好的事**不要**写进 remember、也别塞进 friend.info：那是"这个人是谁"，不是"我还有件事没做"。',
    '- 纯打招呼、寒暄、纯情绪（"在吗""哈哈哈"）不用记；记之前先看上面【你记得这个群的事】，已经有的事别再记一遍。',
    '- 上面这些确实都没有，围栏就写 {}（空对象），不要写别的。',
    '- 第一次见到某个群友，或者他说了自己是谁/在做什么，就写 friend（默认就是这条消息的说话人）。',
    '- 情绪明显（开心、无语、委屈、得意、生气）可以配一张表情：meme 填上面候选里的 id；不确定就别填。',
    '- 围栏只给程序读，不会发进群；正文里不要再出现花括号。',
    '- 不想说话时：正文留空，只回 {"silent":true}。偶尔不想说话很正常。',
    `- 现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}。`,
  ].join('\n');

  const stateBlock = `【你现在的状态】${energyLabel(energy)}（能量 ${Math.round(energy * 100)}/100）`;

  // 刚刚发生的群系统通知（撤回/进群/退群…）。它们只出现在这一轮，不进历史。
  let noticeBlock = '';
  const notices = Array.isArray(info.notices) ? info.notices : [];
  if (notices.length) {
    noticeBlock = ['【刚刚群里发生的事】', ...notices.slice(-3).map((item) => `- ${item.text}`)].join('\n');
  }

  let notesBlock = '';
  const notes = Array.isArray(info.notes) ? info.notes : [];
  if (notes.length) {
    let text = '【你记得这个群的事】\n';
    for (const row of notes.slice(-12)) {
      // 挂到人身上的记忆把名字写出来（`时先思：在考研`），模型答话时才知道说的是谁。
      const who = stripControl(row.whoName || '');
      const line = `- ${who ? `${who}：` : ''}${stripControl(row.text)}\n`;
      if (Array.from(text + line).length > NOTES_INJECT_CHARS) break;
      text += line;
    }
    notesBlock = text.trim();
  }

  // 短期记忆（待办/约好的事）：单独一段，而且只活 24 小时 —— 混进 notes 会让旧待办
  // 变成"事实"，越攒越多。
  let todoBlock = '';
  const todo = Array.isArray(info.todo) ? info.todo : [];
  if (todo.length) {
    const list = todo.slice(-6).map((row) => {
      const who = stripControl(row.whoName || '');
      return `- ${who ? `${who}：` : ''}${stripControl(row.text)}`;
    });
    todoBlock = ['【还没做完的事（做完就用 done 消掉）】', ...list].join('\n');
  }

  let friendBlock = '';
  const friend = info.friend;
  if (friend && (friend.nickname || friend.info)) {
    const aliases = (friend.aliases || []).map((a) => stripControl(a)).filter(Boolean);
    const alias = aliases.length ? `（也叫 ${aliases.join('、')}）` : '';
    friendBlock = `【你认识的群友】${stripControl(friend.nickname) || '这位'}${alias}：${stripControl(friend.info) || '还没什么印象'}`;
  }

  let stickerBlock = '';
  const candidates = Array.isArray(info.candidates) ? info.candidates : [];
  if (candidates.length) {
    const list = candidates.map((row) => `- ${row.hash} ${stripControl(row.tag)}：${stripControl(row.description) || '（没描述）'}`);
    stickerBlock = ['【表情包】想配表情时，把**下面某一个 id 填进围栏的 meme**（正文里不要写编号，正文是给群里看的话）：', ...list].join('\n');
  }

  // 群里刚出现的新图：模型看到描述后决定要不要收进图库（`save_meme`）。
  let pendingBlock = '';
  const pending = Array.isArray(info.pending) ? info.pending : [];
  if (pending.length) {
    const list = pending.slice(-4).map((row) => `- ${row.hash} ${stripControl(row.tag)}：${stripControl(row.description) || '（没描述）'}`);
    // 「看一下然后随便」等于不决定：真机上这条链一整晚收了 0 张（待收藏区一直是满的）。
    // 所以要它**表态**——用得上就填一张，一张都不值得就写 {}。
    pendingBlock = [
      '【群里刚发的新表情】挑一张：如果它以后聊天真用得上，就把它的 id 写进 save_meme（只填一张）；全都用不上就在围栏里写 {}。不要不表态：',
      ...list,
    ].join('\n');
  }

  // 有人刚在跟它说话：把"刚才群里还在聊的"带上，这样它接得上话题。
  // 这些行不进 history（那是"谁问了什么、我答了什么"的转写），只在这一次的 system 里。
  let chatterBlock = '';
  const chatter = Array.isArray(info.chatter) ? info.chatter : [];
  if (chatter.length) {
    chatterBlock = ['【刚才群里在聊】', ...chatter.map((line) => `${stripControl(line.speaker)}：${stripControl(line.text)}`)].join('\n');
  }

  return withBudget(
    [persona || DEFAULT_PERSONA, rules, stateBlock, noticeBlock, chatterBlock, todoBlock, notesBlock, friendBlock, stickerBlock, pendingBlock],
    3800,
  );
}

/** Trims a model reply into something a group accepts. */
function tidyReply(text, maxChars) {
  let out = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    // *摇尾巴* is how models write an action, and deleting the asterisks left a bare
    // "摇尾巴" hanging at the end of a line - a stage direction that lost its brackets,
    // which no one types in a group. Chinese brackets are what a person would type.
    // The lookarounds keep **bold** out of this: a bold pair has an asterisk where the
    // inner text should start, so it falls through to the stripper below.
    .replace(/(^|[^*])\*([^*\n]{1,20})\*(?!\*)/g, '$1（$2）')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*(机器人|助手|AI)\s*[:：]\s*/i, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return trimTo(out, maxChars);
}

/** 能量不说出去，但工坊得看得见：把它和记忆条数写进群索引那一条记录里。 */
function publishGroupState(groupID, patch) {
  const id = String(groupID);
  const entry = state.groups.get(id);
  if (!entry) return;
  if (Number.isFinite(patch.energy)) entry.energy = Math.round(patch.energy * 100) / 100;
  if (Number.isFinite(patch.notes)) entry.notes = patch.notes;
  state.groups.set(id, entry);
  schedulePersist();
}

/** Reads one group's recent turns from the plugin's own storage. */
async function loadHistory(groupID, turns) {
  if (!granted.has('storage')) return [];
  const key = historyKey(groupID);
  let raw = '';
  try {
    const res = await request('storage.get', { key });
    raw = res && res.value ? String(res.value) : '';
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const text = String(item.text || '').trim();
    if (!text) continue;
    out.push({ role, text });
  }
  return out.slice(-Math.max(2, turns * 2));
}

/**
 * Records that this group is ALIVE, whether or not the bot answers it.
 *
 * It is separate from `remember` on purpose: the memory is what the model is told,
 * while this index is "which rooms had people talking recently" - the only thing
 * the proactive path needs to avoid talking into an empty room. Counting only the
 * answered messages would make an idle bot conclude that every group is dead and
 * therefore never speak, which is the one outcome the feature must not have.
 */
function touchGroup(groupID, groupName) {
  const entry = state.groups.get(String(groupID)) || {
    id: String(groupID),
    name: groupName || '',
    count: 0,
    lastAt: 0,
  };
  entry.lastAt = Date.now();
  if (groupName) entry.name = groupName;
  state.groups.set(String(groupID), entry);
  schedulePersist();
}

/**
 * Appends this exchange to the group's memory.
 *
 * `askerText` may be null, which is how a proactive line is stored: there was no
 * question, and inventing one ("（主动开口）" as a user turn) would teach the model
 * on the next turn that someone addressed it with that string.
 */
async function remember(groupID, groupName, askerText, replyText, turns) {
  if (!granted.has('storage')) return;
  const kept = await loadHistory(groupID, turns);
  if (askerText) kept.push({ role: 'user', text: askerText });
  kept.push({ role: 'assistant', text: replyText });
  const trimmed = kept.slice(-Math.max(2, turns * 2));
  const key = historyKey(groupID);
  const entry = state.groups.get(String(groupID)) || {
    id: String(groupID),
    name: groupName || '',
    count: 0,
    lastAt: 0,
  };
  entry.count += 1;
  entry.lastAt = Date.now();
  if (groupName) entry.name = groupName;
  state.groups.set(String(groupID), entry);
  try {
    await request('storage.set', { key, value: JSON.stringify(trimmed) });
  } catch (err) {
    note(`记忆保存失败：${err && err.message}`);
  }
  schedulePersist();
}

/**
 * 群成员名单：群名片/昵称 → QQ 号，10 分钟缓存。
 *
 * 只为了"把正文里的 `@昵称` 换成真正的 @ 段"。失败也写进缓存（空名单）：一条没有 @ 的回复
 * 不值得每句话都去问一次协议端。
 */
async function groupMembers(groupID) {
  const id = String(groupID);
  const now = Date.now();
  const cached = state.members.get(id);
  if (cached && now - cached.at < 10 * 60_000) return cached.list;
  let list = [];
  try {
    const res = await api('get_group_member_list', { group_id: Number(groupID) });
    const rows = Array.isArray(res) ? res : (res && (res.members || res.data)) || [];
    list = (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        id: cleanSegment((row && (row.user_id || row.uin || row.id)) || ''),
        names: [row && row.card, row && row.nickname, row && row.name]
          .map((name) => String(name || '').trim())
          .filter(Boolean),
        // 角色必须留着：`@群主` 只能靠它认人。真机上 `get_group_info` 是不可用的，群主只能
        // 从这份名单里按 role=owner 找 —— 少了这个字段，"群主"就成了谁也匹配不上的名字。
        role: String((row && (row.role || row.member_role)) || '').toLowerCase(),
      }))
      .filter((row) => row.id);
  } catch (err) {
    if (!state.unknownEvents.has('group_members')) {
      state.unknownEvents.add('group_members');
      note(`读不到群成员名单，正文里的 @昵称 会当作普通文字发出去：${(err && err.message) || err}`);
    }
  }
  state.members.set(id, { at: now, list });
  return list;
}

/**
 * 把 `@昵称` 切成真正的 @ 段。
 *
 * 模型不知道 QQ 号，它只会写 `@张三`；原样发出去群里看到的只是几个字，@ 不到人。匹配优先
 * 长的名字（"@张三丰"不该被"@张三"截走），找不到对应成员就保持普通文字。
 */
async function textSegments(groupID, text) {
  const raw = String(text || '');
  if (!raw) return [];
  const members = await groupMembers(groupID);
  const names = [];
  for (const row of members) for (const name of row.names) names.push({ name, id: row.id });
  if (!names.length) return [{ type: 'text', data: { text: raw } }];
  names.sort((a, b) => Array.from(b.name).length - Array.from(a.name).length);
  const out = [];
  let cursor = 0;
  while (cursor < raw.length) {
    let best = null;
    for (const candidate of names) {
      const at = raw.indexOf(`@${candidate.name}`, cursor);
      if (at < 0) continue;
      if (!best || at < best.at) best = { at, id: candidate.id, name: candidate.name };
    }
    if (!best) break;
    if (best.at > cursor) out.push({ type: 'text', data: { text: raw.slice(cursor, best.at) } });
    // 段类型必须叫 `mention`：入站的 @ 就是这个类型（见 mentionsBot / plainText），
    // 发出去时写成 `at` 协议端不认识，会静默丢掉 —— 真机上就是"发了一条带 @ 的提醒，
    // 群里却什么都没有"，找了半天才发现是段名错了。
    out.push({ type: 'mention', data: { user_id: Number(best.id) } });
    cursor = best.at + 1 + best.name.length;
  }
  if (cursor < raw.length) out.push({ type: 'text', data: { text: raw.slice(cursor) } });
  return out.length ? out : [{ type: 'text', data: { text: raw } }];
}

/**
 * Sends one text message back into the group, optionally quoting the question.
 *
 * 引用是**概率**（`quoteChance`，0-100）：每条都引用像复读机，从不引用又接不住"你说的那句"。
 * 掷骰子的地方只有这一处 —— 主动开口/攒批那两条路传的就是 `null`（没有可引用的消息）。
 */
async function sendGroupReply(groupID, messageSeq, text, prefixSegments = []) {
  const segments = [];
  // `null` means "there is no message to quote" (a proactive line). The check is
  // explicit rather than `Number.isFinite` alone, because Number(null) is 0 and a
  // reply segment pointing at seq 0 is a protocol error rather than "no quote".
  const canQuote = messageSeq !== null && messageSeq !== undefined &&
    Number.isFinite(Number(messageSeq));
  const quoteChance = number(state.cfg.quoteChance, 60, 0, 100);
  if (canQuote && quoteChance > 0 && Math.random() * 100 < quoteChance) {
    segments.push({ type: 'reply', data: { message_seq: Number(messageSeq) } });
  }
  // 已经解析好的人（`@群主`、`@全体成员`、纯 QQ 号）走这里；昵称仍然交给 textSegments
  // 去和正文里的 `@昵称` 对齐，免得同一个人被 @ 两次。
  for (const seg of prefixSegments || []) segments.push(seg);
  segments.push(...await textSegments(groupID, text));
  // 带 @ 的消息把实际发出的段记一行。真机上"日志说 @ 了、群里却没有"排查了很久，而段名、
  // user_id 就在这一行里 —— 有了它下次不用猜。
  const mentions = segments.filter((seg) => seg && (seg.type === 'mention' || seg.type === 'mention_all'));
  if (mentions.length) note(`群 ${groupID}：这条带 @，段=${JSON.stringify(mentions)}`);
  await api('send_group_message', { group_id: Number(groupID), message: segments });
  state.counts.replies += 1;
}

/**
 * 把 `at` 里的名字变成可以直接发的段：能解析的（`群主`/`全体成员`/`我`/QQ 号）返回段，
 * 认不出来的返回名字（交给 textSegments 当普通文字 @ 出去）。
 */
async function mentionSegmentsFor(groupID, names, askerID) {
  const segments = [];
  const leftovers = [];
  for (const name of names || []) {
    const who = await resolveMention(groupID, name, askerID);
    if (who && who.kind === 'all') segments.push({ type: 'mention_all', data: {} });
    // `name` 是顺手带上的：有的协议端用它渲染 @，没有就忽略，不会更糟。
    else if (who && who.kind === 'id') segments.push({ type: 'mention', data: { user_id: Number(who.id) } });
    else leftovers.push(name);
  }
  return { segments, leftovers };
}

/**
 * 被戳一戳时的反应。
 *
 * 为什么单独做：戳一戳是**冲它来的**一个动作，不是"群里发生了什么"的背景。原来它只被塞进
 * 下一条 prompt 的通知区（"有人戳了一戳"），于是被戳了十下也可能一句都不吭。
 *
 * 三条设计约束：
 *   · **不调模型**：戳一戳很容易被连点，一次模型调用换一句"别戳我"太贵；
 *   · **每群 60 秒最多一次**：连点的人只会看到一次反应，不会刷屏；
 *   · 只回应"戳的是机器人"的那些（`target_id` 之类指向自己）。认不出目标时就当是戳它 ——
 *     QQ 的戳一戳绝大多数就是戳机器人。
 */
const POKE_LINES = [
  '戳我干嘛，手痒？',
  '别戳，痒。',
  '再戳我可要咬你了。',
  '戳坏了你赔吗？',
  '有话说，别动手。',
];
const POKE_COOLDOWN_MS = 60_000;

/** 这个事件是不是"戳一戳"（各家事件名不同，一起认）。 */
function isPokeEvent(event) {
  const type = String((event && event.event_type) || '');
  // Milky 的权威名字是 `group_nudge` / `friend_nudge`（见协议端文档的事件表）；
  // 其余是 OneBot/别的实现里的叫法，一起认。
  if (type === 'group_nudge' || type === 'friend_nudge') return true;
  if (type === 'group_poke' || type === 'friend_poke' || type === 'nudge') return true;
  // OneBot 风格：notice + sub_type=poke
  const data = (event && event.data) || {};
  return String(data.sub_type || '').toLowerCase() === 'poke';
}

/** 戳的是不是机器人。字段名各家不同，认不出目标时按"是"处理。 */
function pokeTargetsBot(data, selfID) {
  const self = String(selfID || state.selfID || '');
  const target = String(
    (data && (data.target_id || data.poked_id || data.poked || data.target || data.receiver_id)) || '',
  );
  if (!target) return true;
  return Boolean(self) && target === self;
}

/**
 * 戳回去。
 *
 * Milky 的接口叫 **`send_group_nudge`**（`{group_id, user_id}`，见协议端文档 8 节前那张
 * API 表）—— 我一开始按直觉写成 `send_group_poke`/`group_poke`/`send_poke`，三个都不存在，
 * 于是日志里一直是"协议端不支持戳人"。名字对的就先试，其余只在别的协议端上兜底。
 */
async function pokeBack(groupID, userID) {
  const attempts = [
    { name: 'send_group_nudge', params: { group_id: Number(groupID), user_id: Number(userID) } },
    { name: 'send_group_poke', params: { group_id: Number(groupID), user_id: Number(userID) } },
  ];
  for (const attempt of attempts) {
    try {
      await api(attempt.name, attempt.params);
      return attempt.name;
    } catch {
      // 下一种写法
    }
  }
  if (!state.unknownEvents.has('poke_back')) {
    state.unknownEvents.add('poke_back');
    note('协议端不支持戳人（send_group_nudge 也没有），被戳时改成回一句话');
  }
  return '';
}

/**
 * 戳一戳 → 有概率戳回去，否则回一句话。
 *
 * 概率来自 `pokeBackChance`（填概率，没有"总是/从不"的开关）。这里**不发表情**：
 * 戳一戳是高频动作，若这里也贴图，表情冷却会被它吃掉，真正回答提问时反而贴不出来。
 *
 * 不调模型、每群 60 秒一次：戳一戳很容易被连点，一次模型调用换一句"别戳我"太贵。
 */
async function reactToPoke(groupID, data) {
  const id = String(groupID || '');
  if (!id || !groupAllowed(id)) return false;
  const self = String(state.selfID || '');
  if (!pokeTargetsBot(data, self)) return false;
  const now = Date.now();
  if (now - (state.pokedAt.get(id) || 0) < POKE_COOLDOWN_MS) return false;
  const poker = cleanSegment((data && (data.user_id || data.sender_id)) || '');
  if (poker && self && poker === self) return false; // 自己戳自己，不理
  if (!poker && !state.unknownEvents.has('poke_shape')) {
    // 认不出是谁戳的：把原始字段记一次。各家协议端的字段名不一样，猜不如看。
    state.unknownEvents.add('poke_shape');
    note(`戳一戳事件的字段：${JSON.stringify(data || {}).slice(0, 240)}`);
  }
  state.pokedAt.set(id, now);

  // ① 有概率戳回去。协议端不支持时往下走，别让"戳回去"变成沉默。
  const backChance = number(state.cfg.pokeBackChance, 40, 0, 100);
  if (poker && backChance > 0 && Math.random() * 100 < backChance) {
    const used = await pokeBack(id, poker);
    if (used) {
      note(`群 ${id}：被 ${poker} 戳了，戳回去了（${used}，概率 ${backChance}%）`);
      return true;
    }
  }

  // ② 回一句话，并 @ 戳它的人（名字拿不到，只能用 QQ 号拼段）。
  const line = POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)];
  const segments = [];
  if (poker) segments.push({ type: 'mention', data: { user_id: Number(poker) } });
  segments.push({ type: 'text', data: { text: segments.length ? ` ${line}` : line } });
  try {
    await api('send_group_message', { group_id: Number(id), message: segments });
    state.counts.replies += 1;
    note(`群 ${id}：被戳了一下，回了一句（${poker ? `@${poker} ` : ''}${line}）`);
  } catch (err) {
    note(`回应戳一戳失败：${(err && err.message) || err}`);
    return false;
  }
  // 只回一句话，**不贴表情**：戳一戳是高频动作，若这里也发图，表情冷却会被它吃掉，
  // 真正回答提问时反而贴不出来。表情只跟"回答"走（见 maybeSendSticker）。
  return true;
}

/**
 * 带视频/语音的消息不回。
 *
 * WHY：这类消息它一点都收不到，却会顺着"有人 @ 我"照常答——于是产出"这视频挺有意思""你声音
 * 真好听"这种凭空的话。宁可沉默，也不瞎猜：群里看到"没理我"，总比"胡说我发的东西"好。
 *
 * 段名按各家实现的常见写法都收：视频 `video`/`short_video`，语音 `record`/`voice`/`audio`。
 * 这条消息仍然进背景聊天缓冲（占位符写明"看不到/听不到"），所以攒批那一路也不会把它当成
 * 看过、听过的东西去接话。
 */
const BLIND_SEGMENT_KINDS = new Map([
  ['video', '视频'],
  ['short_video', '视频'],
  ['record', '语音'],
  ['voice', '语音'],
  ['audio', '语音'],
]);

/** 消息里第一个"看不见/听不到"的段是什么（引用里的也算）。没有就返回空串。 */
function blindKindOf(segments) {
  for (const seg of segments || []) {
    if (!seg || !seg.type) continue;
    const kind = BLIND_SEGMENT_KINDS.get(String(seg.type));
    if (kind) return kind;
    // 引用里带着视频/语音也算：那句话八成就是在说那个东西。
    if (seg.type === 'reply' && seg.data && Array.isArray(seg.data.segments)) {
      const inner = blindKindOf(seg.data.segments);
      if (inner) return inner;
    }
  }
  return '';
}

function hasVideoSegment(segments) {
  return Boolean(blindKindOf(segments));
}

/** 一个群 10 分钟最多说一次"这条带了视频/语音，我看不到"，否则每种消息都刷一行。 */
function noteVideoSkipped(groupID, segments) {
  const now = Date.now();
  if (now - (state.videoSkippedAt.get(String(groupID)) || 0) < 10 * 60_000) return;
  state.videoSkippedAt.set(String(groupID), now);
  const kinds = [...new Set((segments || []).map((seg) => (seg && seg.type) || '').filter(Boolean))];
  const kind = blindKindOf(segments) || '视频';
  const what = kind === '视频' ? '画面看不到' : '听不到声音';
  note(`群 ${groupID}：这条带了${kind}（段类型 ${kinds.join('/')}），${what}，不回`);
}

