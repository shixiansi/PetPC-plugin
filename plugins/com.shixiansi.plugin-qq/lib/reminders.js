// lib/reminders.js —— 定时提醒与 @ 解析
//
// remind 指令落盘、到点发送；"@群主/@全体成员/我/QQ 号"的解析。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- 定时提醒（"每天 5 点 at 我一下"这类）------------------------------------
//
// 模型只能"记下来"，兑现不了 —— 于是群友托付的事永远停在 notes 里。这里给它一个真能兑现的
// 通道：模型下发 `remind`，插件落盘、按时发一条带真 @ 的消息。触发时不调模型（文本早就存好了），
// 所以这件事本身不花钱。

const REMINDERS_KEY = 'state/reminders';
const REMIND_PER_GROUP_MAX = 5;
const REMIND_TICK_MS = 30_000;

/** key 里存的一份提醒：[{group, time:"HH:MM", every:"day"|"once", text, at, lastDay, at_ms}] */
let remindersCache = null;
let remindersLoadedAt = 0;
let reminderTimer = 0;

async function loadReminders(force = false) {
  const now = Date.now();
  if (remindersCache && !force && now - remindersLoadedAt < 60_000) return remindersCache;
  let rows = [];
  try {
    const parsed = JSON.parse((await readKeyText(REMINDERS_KEY)) || '[]');
    if (Array.isArray(parsed)) rows = parsed.filter((row) => row && row.group && row.time && row.text);
  } catch {
    rows = [];
  }
  remindersCache = rows;
  remindersLoadedAt = now;
  return rows;
}

async function saveReminders(rows) {
  remindersCache = Array.isArray(rows) ? rows : [];
  remindersLoadedAt = Date.now();
  await writeJSON(REMINDERS_KEY, remindersCache);
}

/** 每群最多 5 条，超了丢最早的（提醒不是日志，多了就是打扰）。 */
function pruneReminders(rows) {
  const byGroup = new Map();
  for (const row of rows) {
    const key = String(row.group);
    const list = byGroup.get(key) || [];
    list.push(row);
    byGroup.set(key, list);
  }
  const out = [];
  for (const list of byGroup.values()) {
    out.push(...list.slice(-REMIND_PER_GROUP_MAX));
  }
  return out;
}

/** 把模型下发的 remind 归一化；`time` 必须是 HH:MM，其它一律丢掉。 */
function directiveRemind(data) {
  const raw = data && (data.remind || data.reminder);
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(item.time || '').trim());
    if (!match) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    const text = stripControl(item.text || item.say || item.what).slice(0, DIRECTIVE_TEXT_MAX);
    if (!text) continue;
    out.push({
      time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      every: String(item.every || 'day').toLowerCase() === 'once' ? 'once' : 'day',
      text,
      at: stripControl(item.at || item.who || '').replace(/^@/, '').slice(0, 32),
    });
  }
  return out.slice(0, 2);
}

/** 记下提醒（去重：同群同时间同文本只留一条）。 */
/**
 * 记下提醒（去重：同群同时间同文本只留一条）。
 *
 * `asker` 是这条消息的说话人 `{name, id}`。两件事都要在**存的那一刻**做掉：
 *   ① 模型常不写 `at`（真机上"21:10 分 at 我一下"就没写）→ 默认 @ 提要求的这个人；
 *   ② 名字要立刻解析成 QQ 号存下（`atID`），别等到点再查 —— 那时群成员名单未必读得到，
 *      而且 `群主`/`全体成员`/`我` 这类写法根本对不上昵称（这个也是真机上撞到的）。
 */
async function applyReminders(groupID, list, asker = {}) {
  if (!Array.isArray(list) || !list.length) return 0;
  const all = [...(await loadReminders())];
  let added = 0;
  for (const item of list) {
    const dup = all.some((row) => String(row.group) === String(groupID)
      && row.time === item.time && row.text === item.text);
    if (dup) continue;
    const at = stripControl(item.at) || stripControl(asker.name);
    const resolved = at ? await resolveMention(groupID, at, asker.id) : null;
    all.push({
      ...item,
      at,
      atID: resolved && resolved.kind === 'id' ? String(resolved.id) : '',
      atAll: Boolean(resolved && resolved.kind === 'all'),
      group: String(groupID),
      lastDay: '',
      at_ms: Date.now(),
    });
    added += 1;
  }
  if (!added) return 0;
  await saveReminders(pruneReminders(all));
  return added;
}

function startReminders() {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => {
    void reminderTick();
  }, REMIND_TICK_MS);
}

/**
 * 每分钟对一次表：到点的发一条，一天只发一次。
 *
 * 只看 `HH:MM` 相等（而不是"过了点就补发"）：机器人半夜关着，第二天早上不该突然收到昨晚的
 * 提醒——那已经不是提醒了，是噪音。
 */
async function reminderTick(now = new Date()) {
  if (state.ws !== 'open') return 0;
  const all = await loadReminders();
  if (!all.length) return 0;
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  let fired = 0;
  let changed = false;
  const keep = [];
  for (const item of all) {
    if (item.time !== hhmm || item.lastDay === day) {
      keep.push(item);
      continue;
    }
    const outcome = await fireReminder(item);
    if (outcome === 'busy') {
      // 这个群正在回答别人：留着，下一轮再试（提醒可以晚一分钟，插在别人话中间不行）。
      keep.push(item);
      continue;
    }
    changed = true;
    if (outcome === 'sent') {
      fired += 1;
      if (item.every !== 'once') {
        item.lastDay = day;
        keep.push(item);
      }
    }
    // 'drop'（群不在白名单/没这个群）：直接丢掉，不留着无限重试。
  }
  if (changed) await saveReminders(keep);
  return fired;
}

/**
 * 把"要 @ 谁"解析成可以直接发的东西。
 *
 * 模型写的名字千奇百怪：真昵称（`时先思`）、QQ 号、`我`、`群主`、`全体成员`。只按昵称匹配
 * 是不够的 —— 真机上它就写了 `群主`，那谁也匹配不上，到点只剩一句没有 @ 的文本。
 *
 * 返回 `{kind:'id', id}` / `{kind:'all'}` / null。
 */
const MENTION_ALL_NAMES = new Set(['全体成员', '所有人', '大家', '全员', 'all', 'everyone']);
const MENTION_ME_NAMES = new Set(['我', '自己', '本人', 'me']);
const MENTION_OWNER_NAMES = new Set(['群主', '群主本人', 'owner']);

async function resolveMention(groupID, name, askerID = '') {
  const raw = stripControl(name).replace(/^@/, '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (MENTION_ALL_NAMES.has(lower)) return { kind: 'all' };
  if (MENTION_ME_NAMES.has(lower)) {
    const id = cleanSegment(askerID);
    return id ? { kind: 'id', id } : null;
  }
  // 直接给了 QQ 号
  if (/^\d{5,12}$/.test(raw)) return { kind: 'id', id: raw };
  if (MENTION_OWNER_NAMES.has(lower)) {
    const owner = await groupOwner(groupID);
    if (owner) return { kind: 'id', id: owner };
    return null;
  }
  const members = await groupMembers(groupID);
  const exact = members.find((row) => row.names.includes(raw));
  if (exact) return { kind: 'id', id: exact.id };
  // 宽松一点：名字包含关系也算（"时先"能对上"时先思"），但只在唯一命中时才用。
  const loose = members.filter((row) => row.names.some((n) => n.includes(raw) || raw.includes(n)));
  if (loose.length === 1) return { kind: 'id', id: loose[0].id };
  // 名单里没有：可能是**改过的旧昵称**。群友卡片登记过"叫过的所有名字"，去那张表里查一次。
  const alias = await resolveAlias(raw);
  if (alias) return { kind: 'id', id: alias };
  return null;
}

/**
 * 群主的 QQ 号。两个来源，从最可靠的往下试：
 *
 *   1. 群成员名单里 `role=owner` 的那条 —— 名单本来就要读（`@昵称` 也要它），而且真机上
 *      它是有角色的；群里刚有人说过话时，`onGroupMessage` 还会用消息自带的 role 直接缓存；
 *   2. `get_group_info` 的 `owner_id` —— 真机上这个接口常常是"没实现"。
 *
 * 之前只用了第 2 条，于是 `@群主` 永远认不出人来（日志："认不出是谁"）。空结果也不再写缓存：
 * 下次群里刚有群主说话，就有答案了。
 */
async function groupOwner(groupID) {
  const id = String(groupID);
  const cached = state.groupOwner.get(id);
  if (cached) return cached;
  const members = await groupMembers(groupID);
  const fromList = members.find((row) => row.role === 'owner');
  if (fromList) {
    state.groupOwner.set(id, fromList.id);
    return fromList.id;
  }
  let owner = '';
  try {
    const res = await api('get_group_info', { group_id: Number(groupID) });
    const info = (res && (res.group || res)) || {};
    owner = cleanSegment(info.owner_id || info.owner || '');
  } catch (err) {
    if (!state.unknownEvents.has('group_info')) {
      state.unknownEvents.add('group_info');
      note(`读不到群信息，群主只能从成员名单/消息角色里认：${(err && err.message) || err}`);
    }
  }
  if (owner) state.groupOwner.set(id, owner);
  return owner;
}

/** 发一条提醒：能解析出人就发真 @ 段，解析不出来就退回普通文字。 */
async function fireReminder(item) {
  const groupID = String(item.group || '');
  if (!groupID || !groupAllowed(groupID)) return 'drop';
  if (state.busy.has(groupID)) return 'busy';
  const segments = [];
  let atNote = '';
  if (item.atAll) {
    segments.push({ type: 'mention_all', data: {} });
    atNote = '，@全体成员';
  } else if (item.atID) {
    segments.push({ type: 'mention', data: { user_id: Number(item.atID) } });
    atNote = `，@${item.at || item.atID}`;
  } else if (item.at) {
    // 存的时候没解析出来（比如那会儿群成员名单读不到），到点再试一次。
    const who = await resolveMention(groupID, item.at, '');
    if (who && who.kind === 'id') {
      segments.push({ type: 'mention', data: { user_id: Number(who.id) } });
      atNote = `，@${item.at}`;
    } else if (who && who.kind === 'all') {
      segments.push({ type: 'mention_all', data: {} });
      atNote = '，@全体成员';
    } else {
      // 还是认不出：按普通文字发，并且说清楚 —— 别让人以为 @ 到了。
      note(`群 ${groupID}：提醒里的 @${item.at} 认不出是谁，只能按普通文字发出`);
    }
  }
  segments.push({ type: 'text', data: { text: segments.length ? ` ${item.text}` : item.text } });
  try {
    await api('send_group_message', { group_id: Number(groupID), message: segments });
    state.counts.replies += 1;
  } catch (err) {
    note(`定时提醒发送失败（群 ${groupID} ${item.time}）：${(err && err.message) || err}`);
    return 'drop';
  }
  note(`群 ${groupID}：定时提醒已发出（${item.time}，${item.every === 'once' ? '一次性' : '每天'}${atNote}）`);
  return 'sent';
}

/**
 * 最近几条"模型原话"存哪儿。
 *
 * 尾部围栏是 1.12 所有新能力的入口，而"模型到底有没有照约定写"从外面完全看不出来：群里只
 * 看到正文（那正是设计目标），日志只记结论。存一份原话，工坊里一眼就能分清是"模型没写"
 * 还是"我们没认出来"——这两种情况的修法完全不同。
 */
const PROBE_KEY = 'state/probe';

async function recordProbe(groupID, raw) {
  const text = String(raw || '').slice(0, 800);
  if (!text) return;
  let rows = [];
  try {
    const parsed = JSON.parse((await readKeyText(PROBE_KEY)) || '[]');
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    rows = [];
  }
  rows.push({ group: String(groupID), at: Date.now(), raw: text });
  await writeJSON(PROBE_KEY, rows.slice(-3));
}

/**
 * 模型这条回复里没有尾部围栏时记一句（每群 10 分钟最多一次）。
 *
 * 这句话是"记忆为什么一直是空的"唯一能自查的线索：没有围栏，`remember`/`friend`/`meme`/
 * `silent` 全都不会发生，而群里看到的正文一切正常。
 */
function noteMissingFence(groupID, raw) {
  if (splitDirectives(raw).data) return;
  const now = Date.now();
  const last = state.noFenceAt.get(String(groupID)) || 0;
  if (now - last < 10 * 60_000) return;
  state.noFenceAt.set(String(groupID), now);
  note(`群 ${groupID}：模型没带尾部围栏，这次记忆/表情/沉默都没生效（工坊 → 最近一次模型原话）`);
}

/**
 * remember / todo 的条目：可以是字符串，也可以是 `{text, who}`。
 *
 * `who` 是"这句话说的是谁"。有了它，记忆就能挂到 QQ 号上 —— 昵称会改，QQ 不会，
 * 所以换名之后仍然找得到同一个人（也能直接 @ 出来）。
 */
function directiveNotes(value) {
  const raw = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const out = [];
  for (const item of raw) {
    let text = '';
    let who = '';
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      text = stripControl(item.text || item.what || item.fact || item.todo || '');
      who = stripControl(item.who || item.name || item.person || '').replace(/^@/, '').slice(0, 20);
    } else {
      text = stripControl(item);
    }
    if (!text) continue;
    if (Array.from(text).length > DIRECTIVE_TEXT_MAX) continue;
    out.push(who ? { text, who } : { text });
    if (out.length >= 3) break;
  }
  return out;
}

/** Normalises one directive list: strings, trimmed, bounded, at most three. */
function directiveList(value) {
  const raw = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const out = [];
  for (const item of raw) {
    const text = String(item === undefined || item === null ? '' : item).trim();
    if (!text) continue;
    if (Array.from(text).length > DIRECTIVE_TEXT_MAX) continue;
    out.push(text);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 解析一条模型回复：正文 + 可选的表情/记忆/能量指令。
 *
 * 返回值里的 `text` 已经是"只该发到群里"的那部分；`silent` 为真时一个字都不发。
 */
function parseReply(raw) {
  const { body, data } = splitDirectives(raw);
  const legacy = splitStickerTag(body);
  const out = {
    text: legacy.text,
    tag: legacy.tag,
    meme: '',
    saveMeme: [],
    silent: false,
    remember: [],
    forget: [],
    todo: [],
    done: [],
    friend: null,
    energy: 0,
    at: [],
    remind: [],
  };
  if (!data) {
    // 没有围栏：认老标记。〔沉默〕是老写法里的"不想说话"。
    out.silent = /^[〔\[（(]\s*沉默\s*[〕\]）)]$/.test(out.text);
    if (out.silent) out.text = '';
    // 坏掉的/被 max_tokens 截断的 JSON 也常常带着我们的字段名（`"remember":` 之类）。
    // 见到就把那半截连着后面一起切掉——群里看到半截花括号比少一句话难看得多。
    const cut = out.text.search(DIRECTIVE_TAIL_PATTERN);
    if (cut > 0) out.text = out.text.slice(0, cut).trim();
    return out;
  }
  out.remember = directiveNotes(data.remember);
  out.forget = directiveList(data.forget);
  // 短期记忆：待办 / 约好的事 / 要问的问题。做完就用 done 消掉（也会 24 小时自动过期）。
  out.todo = directiveNotes(data.todo || data.todos || data.todo_list);
  out.done = directiveList(data.done || data.finished);
  // 想专门点某个人：`at` 里写名字（也可以直接在正文里写 @昵称，两条路都通）。
  out.at = (Array.isArray(data.at) ? data.at : [data.at])
    .map((item) => stripControl(item).replace(/^@/, '').slice(0, 32))
    .filter(Boolean)
    .slice(0, 2);
  out.remind = directiveRemind(data);
  out.meme = cleanSegment(data.meme || data.sticker || '');
  out.saveMeme = (Array.isArray(data.save_meme) ? data.save_meme : [data.save_meme])
    .map((item) => cleanSegment(item))
    .filter(Boolean)
    .slice(0, 2);
  const silentFlag = data.silent === true || String(data.silent || '').toLowerCase() === 'true';
  // 只给了指令、没有正文，就是"这次不说话"——模型用这种方式顺手记点东西。
  out.silent = silentFlag || out.text === '' || /^[〔\[（(]\s*沉默\s*[〕\]）)]$/.test(out.text);
  if (out.silent && out.text && /^[〔\[（(]/.test(out.text)) out.text = '';
  const energy = Number(data.energy);
  if (Number.isFinite(energy)) out.energy = Math.max(-0.3, Math.min(0.3, energy));
  const friend = data.friend;
  if (friend && typeof friend === 'object' && !Array.isArray(friend)) {
    const aliases = directiveList(friend.aliases).slice(0, 4);
    out.friend = {
      qq: cleanSegment(friend.qq || ''),
      nickname: String(friend.nickname || '').trim().slice(0, 20),
      info: String(friend.info || '').trim().slice(0, DIRECTIVE_TEXT_MAX),
      aliases,
    };
  }
  return out;
}

