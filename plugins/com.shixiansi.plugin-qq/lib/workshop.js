// lib/workshop.js —— 市场面板（工坊）
//
// 状态卡、群列表、记忆卡、表情包管理、待收藏收件箱。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- views -------------------------------------------------------------------

function applyView(surface) {
  const slot = (surface && surface.slot) || '';
  view = slot === 'background' ? 'background' : 'workshop';
  els.root.className = view === 'background' ? 'view-background' : 'view-workshop';
  els.root.dataset.view = view;
  if (els.background) els.background.hidden = view !== 'background';
  if (els.workshop) els.workshop.hidden = view !== 'workshop';
}

function setChip(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  if (tone) el.dataset.state = tone;
}

const STATE_LABEL = {
  connecting: '连接中',
  open: '已连接',
  error: '连接异常（自动重试中）',
  closed: '未连接',
};

function renderFacts(cfg) {
  if (!els.facts) return;
  const atOnly = flag(cfg.atOnly, true);
  const chance = number(cfg.replyChance, 0, 0, 100);
  const proactive = number(cfg.proactiveMinutes, 0, 0, 1440);
  const rows = [
    ['协议端', String(cfg.server || DEFAULTS.server)],
    ['触发', atOnly
      ? '只有 @ 机器人（或前缀）'
      : chance <= 0
        ? '只回应 @ / 前缀（插话概率为 0）'
        : chance >= 100
          ? '每条群消息都回'
          : `每条群消息 ${chance}% 概率插话`],
    ['主动开口', proactive > 0 ? `平均每 ${proactive} 分钟一句` : '关闭'],
    ['自己插话', flag(cfg.batchEnabled, true)
      ? `每群每 ${number(cfg.batchWindowSec, 120, 30, 3600)} 秒最多看一次，每小时最多 ${number(cfg.batchMaxPerHour, 8, 0, 200)} 次`
      : '关闭'],
    ['生效的群', listOf(cfg.groupAllow).length ? listOf(cfg.groupAllow).join('、') : '所有群'],
    ['每群记忆', `${number(cfg.contextTurns, 8, 0, 40)} 条往来 + ${notesMax()} 条要点`],
    ['回复上限', `${number(cfg.replyMaxChars, 300, 20, 2000)} 字`],
    ['同群间隔', `${number(cfg.cooldownSec, 5, 0, 600)} 秒`],
    ['引用提问', (() => {
      const chance = number(cfg.quoteChance, 60, 0, 100);
      if (chance <= 0) return '从不引用';
      if (chance >= 100) return '每条都引用';
      return `${chance}% 的概率引用`;
    })()],
    ['表情候选', `${number(cfg.stickerCandidateMax, 12, 1, 24)} 条 / 次（本地筛，不额外识图）`],
  ];
  // 今日用量由宿主写进 `llm-usage`（它也是预算的执行者）。工坊能读，就顺手显示——
  // "每次回答大概花多少" 是这套东西最该被看见、也最容易看不见的数字。
  const usage = state.usage;
  if (usage && usage.requests > 0) {
    const tokens = (Number(usage.promptTokens) || 0) + (Number(usage.completionTokens) || 0);
    const perCall = Math.round(tokens / usage.requests);
    const budget = number(cfg.llmDailyBudget, 300, 0, 100000);
    rows.push(['今日模型', `${usage.requests} 次调用 · 约 ${(tokens / 1000).toFixed(1)}K tokens（每次约 ${perCall}）`
      + (budget > 0 ? ` · 上限 ${budget} 次` : ' · 不限次数')]);
  }
  els.facts.replaceChildren();
  for (const [label, value] of rows) {
    const li = document.createElement('li');
    const strong = document.createElement('span');
    strong.className = 'fact-label';
    strong.textContent = label;
    const span = document.createElement('span');
    span.textContent = value;
    li.append(strong, span);
    els.facts.appendChild(li);
  }
}

function renderLog() {
  if (!els.log) return;
  els.log.replaceChildren();
  const entries = state.log.slice(-20).reverse();
  els.log.hidden = entries.length === 0;
  if (els.logEmpty) els.logEmpty.hidden = entries.length !== 0;
  for (const line of entries) {
    const li = document.createElement('li');
    li.textContent = line;
    els.log.appendChild(li);
  }
}

function renderGroups() {
  if (!els.groups || !els.groupsBody) return;
  const rows = [...state.groups.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  els.groupsBody.replaceChildren();
  els.groups.hidden = rows.length === 0;
  if (els.groupsEmpty) els.groupsEmpty.hidden = rows.length !== 0;
  for (const row of rows) {
    const tr = document.createElement('tr');
    const id = document.createElement('td');
    id.textContent = row.id;
    const name = document.createElement('td');
    name.textContent = row.name || '（未命名）';
    const count = document.createElement('td');
    count.textContent = String(row.count || 0);
    // 记忆与能量由机器人写进同一条记录（见 publishGroupState）：工坊读 `state/groups` 就够了，
    // 不必为每个群再去读一遍 notes/energy 文件。
    // 记忆与能量优先用索引里的字段（机器人回答后写的），没有就用工坊自己读到的值。
    const stats = (state.groupStats && state.groupStats.get(String(row.id))) || {};
    const notesCount = Number.isFinite(Number(row.notes)) ? Number(row.notes) : stats.notes;
    const energyValue = Number.isFinite(Number(row.energy)) ? Number(row.energy) : stats.energy;
    // 「记忆」那一格是入口而不是数字：点它打开这个群的记忆卡（逐条看/删/补）。
    const notes = document.createElement('td');
    const openNotes = document.createElement('button');
    openNotes.type = 'button';
    openNotes.className = 'ghost';
    openNotes.dataset.group = String(row.id);
    openNotes.textContent = Number.isFinite(notesCount) && notesCount > 0 ? `${notesCount} 条` : '加一条';
    openNotes.title = '看/改这个群的记忆';
    openNotes.addEventListener('click', () => void openMemoryCard(row));
    notes.appendChild(openNotes);
    const energy = document.createElement('td');
    energy.textContent = Number.isFinite(energyValue) ? `${Math.round(energyValue * 100)}` : '—';
    const last = document.createElement('td');
    last.textContent = row.lastAt
      ? new Date(row.lastAt).toLocaleString('zh-CN', { hour12: false })
      : '';
    const action = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = '忘掉这个群';
    button.addEventListener('click', () => void forgetGroup(row));
    action.appendChild(button);
    tr.append(id, name, count, notes, energy, last, action);
    els.groupsBody.appendChild(tr);
  }
}

/**
 * 打开某个群的记忆卡：逐条看、逐条删、自己补一条。
 *
 * 为什么需要人工编辑：模型记错事（"他下周要出差"记到一个已经搬走的人身上）时，原来唯一的人工
 * 动作是"忘掉这个群"——好的一起扔。现在可以只删错的那条，或者补一条它该知道的。
 */
async function openMemoryCard(row) {
  const groupID = cleanSegment(row && row.id);
  if (!groupID) return;
  state.memoryGroup = groupID;
  state.memoryName = String((row && row.name) || '');
  await renderMemoryCard();
}

/** 画出记忆卡（读一次 notes，机器人每次回答前也会重读同一份文件）。 */
async function renderMemoryCard() {
  if (!els.memoryCard) return;
  const groupID = state.memoryGroup;
  els.memoryCard.hidden = !groupID;
  if (!groupID) return;
  if (els.memoryGroup) {
    els.memoryGroup.textContent = state.memoryName ? `${state.memoryName}（${groupID}）` : groupID;
  }
  let rows = [];
  try {
    rows = await loadNotes(groupID);
  } catch (err) {
    memorySay(`读取记忆失败：${(err && err.message) || err}`, 'warn');
    return;
  }
  if (els.memoryEmpty) els.memoryEmpty.hidden = rows.length !== 0;
  if (!els.memoryList) return;
  els.memoryList.replaceChildren();
  rows.forEach((row, index) => {
    const li = document.createElement('li');
    li.className = 'note-item';
    li.dataset.index = String(index);
    const text = document.createElement('span');
    text.className = 'note-text';
    text.textContent = String(row && row.text ? row.text : '');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.dataset.action = 'delete';
    remove.textContent = '删掉';
    remove.addEventListener('click', () => void removeNote(index));
    li.append(text, remove);
    els.memoryList.appendChild(li);
  });
  await renderReminderList();
}

/** 记忆卡下面的定时提醒列表（能看到、能删；加由模型在回复里下发）。 */
async function renderReminderList() {
  if (!els.remindList) return;
  let all = [];
  try {
    // 强制重读：机器人那边也可能刚记下一条（它每分钟才重读一次）。
    all = await loadReminders(true);
  } catch {
    all = [];
  }
  const rows = all
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => String(row.group) === String(state.memoryGroup));
  if (els.remindEmpty) els.remindEmpty.hidden = rows.length !== 0;
  els.remindList.replaceChildren();
  for (const { row, index } of rows) {
    const li = document.createElement('li');
    li.className = 'note-item';
    li.dataset.time = String(row.time);
    const text = document.createElement('span');
    text.className = 'note-text';
    const every = row.every === 'once' ? '一次' : '每天';
    text.textContent = `${row.time}（${every}）${row.at ? `@${row.at} ` : ''}${row.text}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.dataset.action = 'delete-remind';
    remove.textContent = '删掉';
    remove.addEventListener('click', () => void removeReminderAt(index));
    li.append(text, remove);
    els.remindList.appendChild(li);
  }
}

/** 删掉第 index 条提醒（整份列表的位置，不是本群的顺序）。 */
async function removeReminderAt(index) {
  const all = await loadReminders(true);
  if (!all[index]) return;
  const gone = all[index];
  all.splice(index, 1);
  try {
    await saveReminders(all);
    memorySay(`删掉了提醒 ${gone.time}`, 'ok');
    note(`提醒：手工删掉一条（群 ${gone.group} ${gone.time}）`);
  } catch (err) {
    memorySay(`删除失败：${(err && err.message) || err}`, 'warn');
  }
  await renderMemoryCard();
}

/** 删掉第 index 条（按位置删：同样的文本理论上不该有两条，但按位置删永远对）。 */
async function removeNote(index) {
  const groupID = state.memoryGroup;
  if (!groupID) return;
  const rows = await loadNotes(groupID);
  const target = rows[index];
  if (!target) {
    await renderMemoryCard();
    return;
  }
  const kept = rows.filter((_, i) => i !== index);
  try {
    await saveNotes(groupID, kept);
    memorySay(`删掉了「${target.text}」`, 'ok');
    note(`记忆：手工删掉一条（群 ${groupID}）`);
  } catch (err) {
    memorySay(`删除失败：${(err && err.message) || err}`, 'warn');
  }
  await renderMemoryCard();
  await refreshGroupStats();
}

/** 手工补一条：去重（前 12 字）、遵守 `memoryNotesMax` 上限、最新的排在最后。 */
async function addNote() {
  const groupID = state.memoryGroup;
  if (!groupID) return;
  const text = stripControl(els.memoryNew ? els.memoryNew.value : '').slice(0, DIRECTIVE_TEXT_MAX);
  if (!text) {
    memorySay('先写点什么。', 'warn');
    return;
  }
  const rows = await loadNotes(groupID);
  if (rows.some((row) => noteKeyOf(row && row.text) === noteKeyOf(text))) {
    memorySay('这条已经记着了。', 'warn');
    return;
  }
  const cap = notesMax();
  const next = [...rows, { text, at: Date.now() }].slice(-Math.max(1, cap));
  try {
    await saveNotes(groupID, next);
    if (els.memoryNew) els.memoryNew.value = '';
    memorySay('加上了。', 'ok');
    note(`记忆：手工加了一条（群 ${groupID}）`);
  } catch (err) {
    memorySay(`写入失败：${(err && err.message) || err}`, 'warn');
  }
  await renderMemoryCard();
  await refreshGroupStats();
}

/** 记忆卡自己的一行提示（不占用表情包那块的 sticker-status）。 */
function memorySay(text, tone = 'info') {
  if (!els.memoryStatus) return;
  els.memoryStatus.hidden = false;
  els.memoryStatus.dataset.tone = tone;
  els.memoryStatus.textContent = text;
}

/** 改完记忆顺手把群列表那两列刷新一下（否则数字要等下一轮轮询）。 */
async function refreshGroupStats() {
  try {
    state.groupStats = await loadGroupStats([...state.groups.values()]
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)));
    renderGroups();
  } catch {
    // 刷不动就等下一轮轮询，不影响已经写进去的记忆
  }
}

/**
 * Deletes one group's memory: the transcript AND the notes.
 * 「忘掉」必须两样都清。只删往来留着要点，下次回答时它还会说起"张三在考研"——用户按了
 * 那个按钮，看到的就是"它没忘"。群友卡片是**跨群**的（同一个人在别的群也有），所以不删；
 * 那属于"它认识这个人"，不是"这个群聊了什么"。
 */
async function forgetGroup(row) {
  if (!granted.has('storage')) return;
  try {
    await request('storage.remove', { key: historyKey(row.id) });
    await request('storage.remove', { key: notesKey(row.id) });
    state.groups.delete(String(row.id));
    await request('storage.set', {
      key: DATA.groups,
      value: JSON.stringify([...state.groups.values()]),
    });
    renderGroups();
    note(`已清除群 ${row.id} 的记忆（往来与要点）`);
  } catch (err) {
    note(`清除失败：${(err && err.message) || err}`);
  }
}

// --- 表情包管理（市场面板）---------------------------------------------------
//
// The bot fills this library (owner's private message -> vision model -> bytes in
// storage); this section is the only place a human can look at it and re-file it. It
// runs in the MARKET's process and touches exactly three storage keys, all inside
// `media/stickers/` (see the 数据放在哪 section):
//
//   `media/stickers/index`        the index: [{hash, tag, description}]
//   `media/stickers/categories`   the list a human may pick from
//   `media/stickers/bytes/<hash>` the bytes - READ here, and never written or removed
//
// That last line is a promise, not an accident: "I deleted a category" must not delete
// pictures the user collected, so a delete only re-tags index rows (see
// deleteStickerCategory).
//
// LOADING IS PER PAGE ON PURPOSE. A hundred stickers at a few hundred KB each is tens of
// megabytes of base64; reading all of them to draw 24 is how a workshop tab turns into an
// out-of-memory report. Only the current page's `media/stickers/bytes/<hash>` keys are
// read, and the copies are dropped once the user has browsed a couple of pages away.

/** The built-in bucket. Never in `categories`, never renameable, never removable. */
const UNCATEGORIZED = '未分类';
const STICKER_FILTER_ALL = '全部';
/**
 * 「残图」是一个**视图**而不是分类（写成不可能与分类名撞车的记号）。
 *
 * 被宿主下载上限截断过的图看起来完全正常，只是动图只剩前几帧。把这类单独筛出来，用户才知道
 * "要补哪几张"——1.10 时代有 156 张图就是这么悄悄坏掉的。
 */
const STICKER_FILTER_TRUNCATED = '__truncated__';
const STICKER_FILTER_TRUNCATED_LABEL = '残图（被截断）';
const STICKER_PAGE_SIZE = 24;
const STICKER_TAG_MAX_CHARS = 12;

const stickerUI = {
  /** True once the index and the category list have been read at least once. */
  loaded: false,
  /** 待收藏（群里发的新图）：`[{hash, tag, description, at}]`。 */
  pending: [],
  /** 待收藏的字节缓存：hash -> base64，最多十张。 */
  pendingBytes: new Map(),
  index: [],
  categories: [],
  page: 1,
  filter: STICKER_FILTER_ALL,
  moveTarget: UNCATEGORIZED,
  selected: new Set(),
  /** hash -> base64 for the pages the user is looking at (bounded, see below). */
  bytes: new Map(),
  /** The category whose row is in "rename" mode, or '' when none is. */
  editing: '',
  /** Incremented on every page render, so a load for a page already left stops. */
  loadToken: 0,
  bound: false,
};

/** One sticker's category: a missing or blank tag IS 未分类, never a category named "". */
function stickerTagOf(row) {
  const tag = String((row && row.tag) || '').trim();
  return tag || UNCATEGORIZED;
}

/**
 * Every category the UI may offer: the stored list first, then any tag that only the
 * index knows about.
 *
 * The second half is the answer to a real hazard, not a nicety. The vision model is
 * given a CLOSED list of ten categories and keeps producing them whatever a human does
 * here, so deleting "无语" cannot stop the next import from producing it again. Showing
 * such a tag as an ordinary category is what keeps the library navigable: the pictures
 * are reachable, filterable and movable instead of sitting in a name no surface lists.
 */
function stickerCategories() {
  const out = [];
  for (const name of stickerUI.categories) {
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed === UNCATEGORIZED || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  for (const row of stickerUI.index) {
    const tag = stickerTagOf(row);
    if (tag === UNCATEGORIZED || out.includes(tag)) continue;
    out.push(tag);
  }
  return out;
}

/**
 * Parses the stored category list, or null when there is nothing to parse.
 *
 * A garbage value returns null and is REPLACED with the ten defaults: the list is small
 * and reproducible, unlike the index, so recovering from a corrupt one by re-seeding is
 * strictly better than offering an empty list nobody can add to (every add would still
 * work, but the user would silently lose the ten names the model uses).
 */
function parseStoredCategories(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw || ''));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = [];
  for (const item of parsed) {
    const name = String(item === undefined || item === null ? '' : item).trim();
    if (!name || name === UNCATEGORIZED || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

async function saveStickerCategories() {
  await request('storage.set', {
    key: DATA.stickerCategories,
    value: JSON.stringify(stickerUI.categories),
  });
}

/** Writes the whole index. One key, so a batch edit is ONE write. */
async function saveStickerIndex() {
  await request('storage.set', {
    key: DATA.stickerIndex,
    value: JSON.stringify(stickerUI.index),
  });
}

/** Reads both keys and seeds the category list on first run. */
async function loadStickerLibrary() {
  const [indexRes, catRes] = await Promise.all([
    request('storage.get', { key: DATA.stickerIndex }),
    request('storage.get', { key: DATA.stickerCategories }),
  ]);
  const rows = [];
  try {
    const parsed = JSON.parse(String((indexRes && indexRes.value) || '[]'));
    for (const row of Array.isArray(parsed) ? parsed : []) {
      if (!row || typeof row !== 'object' || !row.hash) continue;
      // `...row` 是必须的：索引里除了 hash/tag/description 还有机器人写的使用次数、
      // 关键词、是否自动收藏、是否被截断。只挑三个字段再写回去，等于每改一次分类就把
      // 那些计数抹一次——"优先挑没发过的"于是永远在原地打转。
      rows.push({
        ...row,
        hash: String(row.hash),
        tag: stickerTagOf(row),
        description: String(row.description || ''),
        truncated: Boolean(row.truncated),
      });
    }
  } catch {
    /* an unreadable index is an empty library, not a crash: the importer rewrites it */
  }
  stickerUI.index = rows;

  let categories = parseStoredCategories((catRes && catRes.value) || '');
  let seed = false;
  if (!categories) {
    categories = [...STICKER_TAGS];
    seed = true;
  }
  stickerUI.categories = categories;
  stickerUI.loaded = true;
  if (seed) await saveStickerCategories();
}

/**
 * Admits or refuses one category name.
 *
 * Add and rename share it deliberately: a rule that only one of them applied would make
 * a category creatable but not renamable, which is the kind of asymmetry nobody reports
 * and everybody works around.
 */
function checkStickerCategoryName(raw, except) {
  const name = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!name) return { ok: false, error: '分类名不能为空' };
  if (name === UNCATEGORIZED) {
    return { ok: false, error: `「${UNCATEGORIZED}」是内建分类，不能拿它当分类名` };
  }
  if (Array.from(name).length > STICKER_TAG_MAX_CHARS) {
    return { ok: false, error: `分类名最多 ${STICKER_TAG_MAX_CHARS} 个字符` };
  }
  if (name !== except && stickerCategories().includes(name)) {
    return { ok: false, error: `分类「${name}」已经存在` };
  }
  return { ok: true, name };
}

/** Shows one line in the sticker card's own status area (and in the log for the rest). */
function stickerSay(text, tone) {
  if (!els.stickerStatus) return;
  els.stickerStatus.textContent = text || '';
  els.stickerStatus.hidden = !text;
  els.stickerStatus.dataset.tone = tone || 'info';
}

/** Adds one category. Empty / duplicate / too long / the reserved name are refused. */
async function addStickerCategory(raw) {
  const verdict = checkStickerCategoryName(raw);
  if (!verdict.ok) {
    stickerSay(`新增分类失败：${verdict.error}`, 'warn');
    note(`表情包分类新增失败：${verdict.error}`);
    return false;
  }
  stickerUI.categories.push(verdict.name);
  await saveStickerCategories();
  stickerUI.editing = '';
  stickerSay(`已新增分类「${verdict.name}」`, 'ok');
  note(`新增表情包分类「${verdict.name}」`);
  renderStickerSection();
  return true;
}

/**
 * Renames one category and migrates the index rows that carry the old name.
 *
 * Both halves are needed: leaving the rows behind would make every renamed sticker fall
 * out of the new category and reappear as a discovered tag with the OLD name - the
 * "分类漂移" this whole section exists to prevent.
 */
async function renameStickerCategory(from, raw) {
  const old = String(from || '').trim();
  if (!old || old === UNCATEGORIZED) {
    stickerSay(`「${UNCATEGORIZED}」是内建分类，不能改名`, 'warn');
    note('表情包分类改名失败：「未分类」是内建分类');
    return false;
  }
  const verdict = checkStickerCategoryName(raw, old);
  if (!verdict.ok) {
    stickerSay(`改名失败：${verdict.error}`, 'warn');
    note(`表情包分类改名失败：${verdict.error}`);
    return false;
  }
  if (verdict.name === old) {
    stickerUI.editing = '';
    renderStickerSection();
    return true;
  }
  let moved = 0;
  for (const row of stickerUI.index) {
    if (stickerTagOf(row) !== old) continue;
    row.tag = verdict.name;
    moved += 1;
  }
  const at = stickerUI.categories.indexOf(old);
  if (at >= 0) stickerUI.categories[at] = verdict.name;
  await saveStickerCategories();
  if (moved) await saveStickerIndex();
  if (stickerUI.filter === old) stickerUI.filter = verdict.name;
  if (stickerUI.moveTarget === old) stickerUI.moveTarget = verdict.name;
  stickerUI.editing = '';
  stickerSay(`「${old}」已改名为「${verdict.name}」，${moved} 张随之迁移`, 'ok');
  note(`表情包分类「${old}」已改名为「${verdict.name}」，${moved} 张随之迁移`);
  renderStickerSection();
  return true;
}

/**
 * Removes one category from the list, and re-files its stickers under 未分类.
 *
 * THE BYTES ARE NOT TOUCHED. No `storage.remove`, no `media/stickers/bytes/<hash>` write: a category
 * is a LABEL, and "I deleted a label" must never destroy pictures the user sent to the
 * bot. The index rows keep their hash, so the pictures stay usable - and stay reachable
 * from the 未分类 bucket, which is why that bucket cannot be deleted or renamed.
 */
async function deleteStickerCategory(name) {
  const target = String(name || '').trim();
  if (!target || target === UNCATEGORIZED) {
    stickerSay(`「${UNCATEGORIZED}」是内建分类，不能删除`, 'warn');
    note('表情包分类删除失败：「未分类」是内建分类');
    return false;
  }
  let moved = 0;
  for (const row of stickerUI.index) {
    if (stickerTagOf(row) !== target) continue;
    row.tag = UNCATEGORIZED;
    moved += 1;
  }
  stickerUI.categories = stickerUI.categories.filter((item) => item !== target);
  await saveStickerCategories();
  if (moved) await saveStickerIndex();
  if (stickerUI.filter === target) stickerUI.filter = UNCATEGORIZED;
  if (stickerUI.moveTarget === target) stickerUI.moveTarget = UNCATEGORIZED;
  stickerSay(`分类「${target}」已删除，${moved} 张归入${UNCATEGORIZED}`, 'ok');
  note(`表情包分类「${target}」已删除，${moved} 张归入${UNCATEGORIZED}`);
  renderStickerSection();
  return true;
}

/** Moves every ticked sticker to one category, in a single index write. */
async function moveSelectedStickers(targetRaw) {
  const target = String(targetRaw || '').trim() || UNCATEGORIZED;
  if (!stickerUI.selected.size) {
    stickerSay('先在下面勾选要移动的表情包', 'warn');
    return false;
  }
  const picked = new Set(stickerUI.selected);
  let moved = 0;
  for (const row of stickerUI.index) {
    if (!picked.has(row.hash)) continue;
    if (stickerTagOf(row) === target) continue;
    row.tag = target;
    moved += 1;
  }
  if (!moved) {
    stickerSay(`所选表情包已经都在「${target}」里了`, 'warn');
    return false;
  }
  await saveStickerIndex();
  stickerUI.selected.clear();
  stickerSay(`已把 ${moved} 张表情包移到「${target}」`, 'ok');
  note(`已把 ${moved} 张表情包移到「${target}」`);
  renderStickerSection();
  return true;
}

/** 一键补救：翻群历史把完整的同一张捞回来，成功后重新读库并重画。 */
async function runRecoverTruncated() {
  if (stickerUI.recovering) return;
  stickerUI.recovering = true;
  if (els.stickerRecoverTruncated) els.stickerRecoverTruncated.disabled = true;
  stickerSay('正在翻群历史找完整的图…（可能要几分钟）', 'info');
  try {
    const report = await recoverTruncatedStickers();
    if (!report.broken) {
      stickerSay('没有残图了。', 'ok');
    } else if (!report.history) {
      stickerSay('这个协议端没有提供群历史接口，只能靠重新发一遍图片来补。', 'warn');
    } else {
      stickerSay(
        `看了 ${report.groups} 个群、${report.images} 张图，补回 ${report.matched} 张；`
          + `还剩 ${report.broken - report.matched} 张（历史里找不到完整的那一版）。`,
        report.matched ? 'ok' : 'warn',
      );
    }
    if (report.matched) {
      await loadStickerLibrary();
      stickerUI.bytes.clear();
      renderStickerSection();
    }
  } catch (err) {
    stickerSay(`补图失败：${(err && err.message) || err}`, 'warn');
  } finally {
    stickerUI.recovering = false;
    if (els.stickerRecoverTruncated) els.stickerRecoverTruncated.disabled = false;
    renderStickerSection();
  }
}

/** 一次性删掉所有被截断的残图：索引行 + 字节文件。 */
async function purgeTruncatedStickers() {
  const victims = stickerUI.index.filter((row) => row && row.truncated);
  if (!victims.length) return 0;
  for (const row of victims) {
    try {
      await request('storage.remove', { key: stickerBytesKey(row.hash) });
    } catch {
      // 删不掉就留着：索引行仍然会被移除，下次启动的补标记不会再把它算进来。
    }
  }
  const gone = new Set(victims.map((row) => row.hash));
  stickerUI.index = stickerUI.index.filter((row) => !gone.has(row.hash));
  for (const hash of gone) {
    stickerUI.bytes.delete(hash);
    stickerUI.selected.delete(hash);
  }
  await saveStickerIndex();
  stickerUI.pendingPurge = false;
  stickerSay(`已删除 ${victims.length} 张残图`, 'ok');
  note(`删除了 ${victims.length} 张被截断的表情包`);
  renderStickerSection();
  return victims.length;
}

/**
 * 「待收藏」收件箱：群里发的新图，识图钱已经花了，收不收由人定。
 *
 * 为什么必须有这一块：待收藏区是 10 格的队列，满了就不再识别新图；而真机上模型从没写过
 * `save_meme`（协议里压根没列这个字段），于是队列满了、图库一张没进、每群每小时还在花钱识图。
 * 有了这个列表，至少"已经花掉的钱"能变成图库里的一张图，而不是静静过期。
 */
function renderPendingInbox() {
  if (!els.pendingBlock || !els.pendingList) return;
  const rows = Array.isArray(stickerUI.pending) ? stickerUI.pending : [];
  els.pendingBlock.hidden = rows.length === 0;
  els.pendingList.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'pending-item';
    li.dataset.hash = row.hash;

    const img = document.createElement('img');
    img.className = 'pending-thumb';
    img.alt = row.description || '待收藏的表情';
    img.dataset.hash = row.hash;
    const cached = stickerUI.pendingBytes.get(row.hash);
    if (cached) img.src = `data:${stickerMime(cached)};base64,${cached}`;

    const desc = document.createElement('p');
    desc.className = 'pending-desc';
    desc.textContent = `${row.tag || UNCATEGORIZED}：${row.description || '（没有描述）'}`;

    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'ghost';
    keep.dataset.action = 'keep';
    keep.textContent = '收进图库';
    keep.addEventListener('click', () => void keepPendingSticker(row));
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'ghost';
    drop.dataset.action = 'drop';
    drop.textContent = '丢掉';
    drop.addEventListener('click', () => void dropPendingSticker(row));

    const tools = document.createElement('div');
    tools.className = 'sticker-row';
    tools.append(keep, drop);

    li.append(img, desc, tools);
    els.pendingList.appendChild(li);
  }
  if (rows.length) void loadPendingBytes(rows);
}

/** 只读这一批的字节，读过的不再读（缩略图最多 10 张）。 */
async function loadPendingBytes(rows) {
  if (!granted.has('storage')) return;
  let changed = false;
  for (const row of rows) {
    if (stickerUI.pendingBytes.has(row.hash)) continue;
    try {
      const base64 = await readKeyText(`${COLLECT_PENDING_DIR}/${row.hash}`);
      if (!base64) continue;
      stickerUI.pendingBytes.set(row.hash, base64);
      changed = true;
      const img = els.pendingList
        ? els.pendingList.querySelector(`img[data-hash="${row.hash}"]`)
        : null;
      if (img) img.src = `data:${stickerMime(base64)};base64,${base64}`;
    } catch {
      // 读不出来就留空缩略图，描述还在，照样能决定
    }
  }
  return changed;
}

/** 收一张待收藏进图库（和模型说 `save_meme` 走同一条路）。 */
async function keepPendingSticker(row) {
  try {
    const okMove = await saveCollectedSticker(row.hash);
    if (!okMove) {
      stickerSay('这张已经不在待收藏里了（可能被别的窗口处理过）。', 'warn');
    } else {
      stickerSay(`已收进图库：${row.description || row.tag || row.hash}`, 'ok');
      note(`待收藏：收进图库一张（${row.tag || '未分类'}：${row.description || '无描述'}）`);
    }
    stickerUI.pendingBytes.delete(row.hash);
    await loadStickerLibrary();
    stickerUI.pending = await loadPending();
    renderStickerSection();
  } catch (err) {
    stickerSay(`收进图库失败：${(err && err.message) || err}`, 'warn');
  }
}

/** 丢掉一张待收藏：索引进条与字节都删掉。 */
async function dropPendingSticker(row) {
  try {
    await discardPendingSticker(row.hash);
    stickerUI.pendingBytes.delete(row.hash);
    stickerSay('丢掉了。', 'ok');
    stickerUI.pending = await loadPending();
    renderStickerSection();
  } catch (err) {
    stickerSay(`丢掉失败：${(err && err.message) || err}`, 'warn');
  }
}

/** 把一张待收藏从队列里移除并删掉字节（不收进图库）。 */
async function discardPendingSticker(hash) {
  const id = cleanSegment(hash);
  if (!id) return false;
  const pending = await loadPending();
  if (!pending.some((item) => item.hash === id)) return false;
  await savePending(pending.filter((item) => item.hash !== id));
  try {
    await request('storage.remove', { key: `${COLLECT_PENDING_DIR}/${id}` });
  } catch {
    // 删不掉只是占一点空间
  }
  return true;
}

/** The rows of the current page after the filter, plus the paging arithmetic. */
function stickerPage() {
  const filter = stickerUI.filter;
  const matched = stickerUI.index.filter((row) => {
    if (filter === STICKER_FILTER_ALL) return true;
    // 「残图」不是一个分类，是一个视图：被宿主上限截断过的那几张（看起来正常，其实只有
    // 前几帧）。它得能被单独挑出来，否则用户永远不知道该重新导入哪几张。
    if (filter === STICKER_FILTER_TRUNCATED) return Boolean(row.truncated);
    return stickerTagOf(row) === filter;
  });
  const pages = Math.max(1, Math.ceil(matched.length / STICKER_PAGE_SIZE));
  const page = Math.min(Math.max(1, stickerUI.page), pages);
  stickerUI.page = page;
  const start = (page - 1) * STICKER_PAGE_SIZE;
  return {
    rows: matched.slice(start, start + STICKER_PAGE_SIZE),
    total: matched.length,
    pages,
    page,
  };
}

/** Replaces a <select>'s options, keeping the current choice when it still exists. */
function fillStickerSelect(el, options, selected) {
  if (!el) return;
  el.replaceChildren();
  for (const option of options) {
    const value = typeof option === 'object' ? option.value : option;
    const label = typeof option === 'object'
      ? option.label
      : (value === STICKER_FILTER_TRUNCATED ? STICKER_FILTER_TRUNCATED_LABEL : value);
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    node.selected = value === selected;
    el.appendChild(node);
  }
  el.value = options.some((option) => (typeof option === 'object' ? option.value : option) === selected)
    ? selected
    : (typeof options[0] === 'object' ? options[0].value : options[0]) || '';
}

/**
 * Reads the CURRENT PAGE's bytes only.
 *
 * `storage.get` per hash, not one bulk call: the host's storage API is per key, and the
 * point of this function is that a 100-image library costs 24 reads, not 100.
 */
async function loadStickerPageBytes(rows) {
  if (!granted.has('storage')) return;
  const token = ++stickerUI.loadToken;
  const wanted = new Set(rows.map((row) => row.hash));
  // Drop copies of pages the user has left. Without this a browse through the whole
  // library would leave every image base64-resident in a tab that shows 24 at a time.
  if (stickerUI.bytes.size > STICKER_PAGE_SIZE * 3) {
    for (const hash of [...stickerUI.bytes.keys()]) {
      if (!wanted.has(hash)) stickerUI.bytes.delete(hash);
    }
  }
  for (const row of rows) {
    // A page rendered while this loop was awaiting has taken over: the user paged on.
    if (token !== stickerUI.loadToken) return;
    if (stickerUI.bytes.has(row.hash)) continue;
    try {
      const res = await request('storage.get', { key: stickerBytesKey(row.hash) });
      const base64 = String((res && res.value) || '');
      if (!base64) continue;
      stickerUI.bytes.set(row.hash, base64);
      paintStickerThumb(row.hash);
    } catch (err) {
      note(`读取表情包图片失败：${(err && err.message) || err}`);
    }
  }
}

/** Fills one already-rendered <img> from the byte cache, with the sniffed MIME type. */
function paintStickerThumb(hash) {
  if (!els.stickerGrid) return;
  if (!/^[0-9A-Za-z_-]+$/.test(hash)) return;
  const img = els.stickerGrid.querySelector(`img[data-hash="${hash}"]`);
  const base64 = stickerUI.bytes.get(hash);
  if (!img || !base64) return;
  img.src = `data:${stickerMime(base64)};base64,${base64}`;
  img.dataset.loaded = '1';
}

/** The "3 / 8 selected" line and the select-all box, from the current selection. */
function updateStickerSelection(page) {
  const current = page || stickerPage();
  const hashes = current.rows.map((row) => row.hash);
  const chosen = hashes.filter((hash) => stickerUI.selected.has(hash)).length;
  if (els.stickerSelected) {
    els.stickerSelected.textContent = stickerUI.selected.size
      ? `已选 ${stickerUI.selected.size} 张（本页 ${chosen} 张）`
      : '未选中';
  }
  if (els.stickerSelectPage) {
    els.stickerSelectPage.checked = hashes.length > 0 && chosen === hashes.length;
    els.stickerSelectPage.indeterminate = chosen > 0 && chosen < hashes.length;
  }
}

/** One row of the category list: the built-in bucket, or a name with 改名 / 删除. */
function stickerCategoryRow(item, count) {
  const li = document.createElement('li');
  li.dataset.category = item.name;
  if (!item.builtin && stickerUI.editing === item.name) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cat-input';
    input.value = item.name;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'ghost';
    save.dataset.action = 'rename-save';
    save.textContent = '保存';
    save.addEventListener('click', () => void renameStickerCategory(item.name, input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void renameStickerCategory(item.name, input.value);
      if (event.key === 'Escape') {
        stickerUI.editing = '';
        renderStickerSection();
      }
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost';
    cancel.dataset.action = 'rename-cancel';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => {
      stickerUI.editing = '';
      renderStickerSection();
    });
    const counter = document.createElement('span');
    counter.className = 'cat-count';
    counter.textContent = `${count} 张`;
    li.append(input, save, cancel, counter);
    return li;
  }

  const name = document.createElement('span');
  name.className = 'cat-name';
  name.textContent = item.name;
  const counter = document.createElement('span');
  counter.className = 'cat-count';
  counter.textContent = `${count} 张`;
  li.append(name, counter);
  if (item.builtin) {
    const hint = document.createElement('span');
    hint.className = 'cat-builtin';
    hint.textContent = '内建，不可改名/删除';
    li.appendChild(hint);
    return li;
  }
  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'ghost';
  rename.dataset.action = 'rename';
  rename.dataset.category = item.name;
  rename.textContent = '改名';
  rename.addEventListener('click', () => {
    stickerUI.editing = item.name;
    renderStickerSection();
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ghost';
  remove.dataset.action = 'delete';
  remove.dataset.category = item.name;
  remove.textContent = '删除';
  remove.addEventListener('click', () => void deleteStickerCategory(item.name));
  li.append(rename, remove);
  return li;
}

/** 画出整张表情包卡片（只读 `stickerUI`，不发请求）。 */
function renderStickerSection() {
  if (view !== 'workshop' || !els.stickerGrid) return;
  const categories = stickerCategories();
  if (
    stickerUI.filter !== STICKER_FILTER_ALL &&
    stickerUI.filter !== STICKER_FILTER_TRUNCATED &&
    stickerUI.filter !== UNCATEGORIZED &&
    !categories.includes(stickerUI.filter)
  ) {
    stickerUI.filter = STICKER_FILTER_ALL;
  }
  const page = stickerPage();
  const broken = stickerUI.index.filter((row) => row && row.truncated).length;

  if (els.stickerSummary) {
    const scope = stickerUI.filter === STICKER_FILTER_ALL
      ? '全部'
      : stickerUI.filter === STICKER_FILTER_TRUNCATED
        ? '残图'
        : stickerUI.filter;
    // 残图数量单独说一句：它们看起来正常，但只有前几帧。不知道有几张、是哪几张，用户就
    // 永远不会去补。
    const brokenNote = broken
      ? `；其中 ${broken} 张被截断过（选「残图」查看，重新导入同一张会覆盖）`
      : '';
    els.stickerSummary.textContent =
      `共 ${stickerUI.index.length} 张表情包（${scope} ${page.total} 张）·` +
      ` 第 ${page.page} / ${page.pages} 页${brokenNote}`;
  }

  const filters = [STICKER_FILTER_ALL, ...categories, UNCATEGORIZED];
  if (broken) filters.push(STICKER_FILTER_TRUNCATED);
  fillStickerSelect(els.stickerFilter, filters, stickerUI.filter);

  // 「删除残图」只在残图视图里出现，而且是**两下**：沙箱化的 iframe 不能用 confirm()
  // （没有 allow-modals），所以用"先变成确认、再点一次"代替弹窗。
  if (els.stickerPurgeRow) els.stickerPurgeRow.hidden = stickerUI.filter !== STICKER_FILTER_TRUNCATED || !broken;
  if (els.stickerPurgeTruncated) {
    const armed = Boolean(stickerUI.pendingPurge);
    els.stickerPurgeTruncated.textContent = armed ? `确认删除这 ${broken} 张？` : `删除这 ${broken} 张残图`;
    els.stickerPurgeTruncated.dataset.armed = armed ? '1' : '';
  }
  const moveOptions = [...categories, UNCATEGORIZED];
  if (!moveOptions.includes(stickerUI.moveTarget)) stickerUI.moveTarget = UNCATEGORIZED;
  fillStickerSelect(els.stickerMoveTarget, moveOptions, stickerUI.moveTarget);
  stickerUI.moveTarget = els.stickerMoveTarget
    ? els.stickerMoveTarget.value
    : stickerUI.moveTarget;

  els.stickerGrid.replaceChildren();
  els.stickerGrid.hidden = page.rows.length === 0;
  for (const row of page.rows) {
    const cell = document.createElement('div');
    cell.className = 'sticker-cell';
    cell.dataset.hash = row.hash;
    if (stickerUI.selected.has(row.hash)) cell.classList.add('is-selected');

    const img = document.createElement('img');
    img.className = 'sticker-thumb';
    img.dataset.hash = row.hash;
    img.alt = row.description || '表情包';
    const tooltip = `${stickerTagOf(row)}${row.description ? '：' + row.description : ''}` +
      (row.truncated
        ? '\n（被旧的下载上限截断过，只剩前几帧。把完整的那张重新发给机器人导入，再来删掉这张）'
        : '');
    img.title = tooltip;
    // 被宿主上限截断过的图看起来正常，其实只剩前几帧 —— 给它一个可见的标记，否则用户永远
    // 不知道为什么这张动图"播一半就停"。
    if (row.truncated) cell.dataset.truncated = '1';
    const cached = stickerUI.bytes.get(row.hash);
    if (cached) img.src = `data:${stickerMime(cached)};base64,${cached}`;

    const tools = document.createElement('div');
    tools.className = 'sticker-row';
    const pick = document.createElement('label');
    pick.className = 'sticker-pick';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'sticker-check';
    box.dataset.hash = row.hash;
    box.checked = stickerUI.selected.has(row.hash);
    box.title = '勾选后可批量改分类';
    box.addEventListener('change', () => {
      if (box.checked) stickerUI.selected.add(row.hash);
      else stickerUI.selected.delete(row.hash);
      cell.classList.toggle('is-selected', box.checked);
      updateStickerSelection(page);
    });
    pick.appendChild(box);
    const badge = document.createElement('span');
    badge.className = 'sticker-badge';
    badge.textContent = stickerTagOf(row);
    badge.title = tooltip;
    tools.append(pick, badge);

    const desc = document.createElement('p');
    desc.className = 'sticker-desc';
    desc.textContent = row.description || '（没有描述）';
    desc.title = tooltip;

    cell.append(img, tools, desc);
    els.stickerGrid.appendChild(cell);
  }
  if (els.stickerEmpty) els.stickerEmpty.hidden = page.rows.length !== 0;
  // Only this page's bytes, and only when there is a page to paint.
  if (page.rows.length) void loadStickerPageBytes(page.rows);
  renderPendingInbox();

  if (els.stickerPage) els.stickerPage.textContent = `第 ${page.page} / ${page.pages} 页`;
  if (els.stickerPrev) els.stickerPrev.disabled = page.page <= 1;
  if (els.stickerNext) els.stickerNext.disabled = page.page >= page.pages;

  if (els.stickerCategories) {
    els.stickerCategories.replaceChildren();
    const counts = new Map();
    for (const row of stickerUI.index) {
      const tag = stickerTagOf(row);
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const rows = [
      { name: UNCATEGORIZED, builtin: true },
      ...categories.map((name) => ({ name, builtin: false })),
    ];
    for (const item of rows) {
      els.stickerCategories.appendChild(stickerCategoryRow(item, counts.get(item.name) || 0));
    }
  }

  updateStickerSelection(page);
}

/** Reads the two keys and redraws the card. Called from renderWorkshop (and its poll). */
async function loadStickerSection() {
  if (!granted.has('storage') || view !== 'workshop' || !els.stickerGrid) return;
  // A rename box is open: the five-second poll must not pull the input out from under
  // the user's cursor, so this round is skipped entirely.
  if (stickerUI.editing) return;
  try {
    await loadStickerLibrary();
    stickerUI.pending = await loadPending();
  } catch (err) {
    stickerSay(`读取表情包索引失败：${(err && err.message) || err}`, 'warn');
    return;
  }
  renderStickerSection();
}

/** Wires the sticker card's controls ONCE; every handler re-reads the live state. */
function bindStickerControls() {
  if (stickerUI.bound) return;
  stickerUI.bound = true;
  if (els.memoryAdd) els.memoryAdd.addEventListener('click', () => void addNote());
  if (els.memoryNew) {
    els.memoryNew.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void addNote();
    });
  }
  if (els.stickerFilter) {
    els.stickerFilter.addEventListener('change', () => {
      stickerUI.filter = els.stickerFilter.value || STICKER_FILTER_ALL;
      stickerUI.page = 1;
      stickerUI.selected.clear();
      renderStickerSection();
    });
  }
  if (els.stickerMoveTarget) {
    els.stickerMoveTarget.addEventListener('change', () => {
      stickerUI.moveTarget = els.stickerMoveTarget.value || UNCATEGORIZED;
    });
  }
  if (els.stickerMove) {
    els.stickerMove.addEventListener('click', () => {
      void moveSelectedStickers(els.stickerMoveTarget ? els.stickerMoveTarget.value : '');
    });
  }
  if (els.stickerSelectPage) {
    els.stickerSelectPage.addEventListener('change', () => {
      const page = stickerPage();
      for (const row of page.rows) {
        if (els.stickerSelectPage.checked) stickerUI.selected.add(row.hash);
        else stickerUI.selected.delete(row.hash);
      }
      renderStickerSection();
    });
  }
  if (els.stickerPrev) {
    els.stickerPrev.addEventListener('click', () => {
      stickerUI.page = Math.max(1, stickerUI.page - 1);
      renderStickerSection();
    });
  }
  if (els.stickerNext) {
    els.stickerNext.addEventListener('click', () => {
      stickerUI.page += 1;
      renderStickerSection();
    });
  }
  const submitNewCategory = () => {
    if (!els.stickerNewName) return;
    void addStickerCategory(els.stickerNewName.value).then((ok) => {
      if (ok) els.stickerNewName.value = '';
    });
  };
  if (els.stickerAdd) els.stickerAdd.addEventListener('click', submitNewCategory);
  if (els.stickerPurgeTruncated) {
    els.stickerPurgeTruncated.addEventListener('click', () => {
      // 两下：第一下把按钮变成"确认删除"，第二下才真的删。沙箱里没有 confirm()。
      if (!stickerUI.pendingPurge) {
        stickerUI.pendingPurge = true;
        renderStickerSection();
        return;
      }
      void purgeTruncatedStickers();
    });
  }
  if (els.stickerRecoverTruncated) {
    els.stickerRecoverTruncated.addEventListener('click', () => void runRecoverTruncated());
  }
  if (els.stickerNewName) {
    els.stickerNewName.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submitNewCategory();
    });
  }
}

/** Reads the files the bot wrote, so the workshop shows its state rather than its own. */
async function loadSnapshot() {
  if (!granted.has('storage')) return;
  try {
    const [status, groups, log, usage, probe] = await Promise.all([
      request('storage.get', { key: DATA.status }),
      request('storage.get', { key: DATA.groups }),
      request('storage.get', { key: DATA.log }),
      // 宿主自己写的用量计数（键是扁平的 `llm-usage`，它就在插件私有目录里）。
      request('storage.get', { key: 'llm-usage' }).catch(() => null),
      // 机器人存下的"模型原话"，用来判断围栏到底有没有出现。
      request('storage.get', { key: PROBE_KEY }).catch(() => null),
    ]);
    if (probe && probe.value) {
      try {
        const rows = JSON.parse(probe.value);
        state.probe = Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
      } catch {
        state.probe = null;
      }
    }
    if (usage && usage.value) {
      try {
        const parsed = JSON.parse(usage.value);
        // 宿主按**本地日**翻滚，所以这里也必须用本地日期：toISOString 是 UTC，东八区
        // 凌晨 0-8 点会算出"昨天"，于是刚花掉的钱不显示。
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        state.usage = parsed && (!parsed.date || String(parsed.date) === today) ? parsed : null;
      } catch {
        /* 坏文件就当没有用量：这一行不显示比显示错的好 */
      }
    }
    if (status && status.value) {
      try {
        const parsed = JSON.parse(status.value);
        state.ws = parsed.state || state.ws;
        state.wsError = parsed.error || '';
        state.selfID = parsed.selfID || state.selfID;
        state.selfName = parsed.selfName || state.selfName;
        state.counts = parsed.counts || state.counts;
        if (els.statusNote) {
          els.statusNote.textContent = parsed.at
            ? `由桌宠进程在 ${new Date(parsed.at).toLocaleString('zh-CN', { hour12: false })} 写入。`
            : '还没有写入。';
        }
      } catch {
        /* a corrupt snapshot is not worth an error: the next write fixes it */
      }
    }
    if (groups && groups.value) {
      try {
        const parsed = JSON.parse(groups.value);
        if (Array.isArray(parsed)) {
          state.groups = new Map(parsed.map((row) => [String(row.id), row]));
          // 工坊读到的就是它写回去的那一份（「忘掉这个群」会写这个键），所以从这里
          // 开始这张表可以发布。
          state.groupsLoaded = true;
        }
      } catch {
        /* ignore */
      }
    }
    if (log && log.value) {
      try {
        const parsed = JSON.parse(log.value);
        if (Array.isArray(parsed)) state.log = parsed.slice(-maxLogEntries);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    if (els.statusNote) els.statusNote.textContent = '读取不到桌宠那边的状态。';
  }
}

async function renderWorkshop() {
  await loadSnapshot();
  // The sticker library is read here rather than on its own timer: this function is what
  // the five-second poll calls, and one round of requests per refresh is cheaper than two
  // independent pollers that could paint a half-updated card.
  await loadStickerSection();
  let values = {};
  if (granted.has('plugin.config')) {
    try {
      const res = await request('config.get', {});
      values = (res && res.values) || {};
    } catch (err) {
      /* the facts below fall back to the manifest defaults */
    }
  }
  renderFacts({ ...DEFAULTS, ...values });
  // 工坊也要能打协议端：残图补救（翻群历史把完整的图捞回来）就在这一侧做，而它需要那份
  // 地址与令牌。`state.base` 只在机器人那条路上被设过，这里补上——同一套 `api()` 于是两边
  // 都能用，不必再写一份协议端调用。
  state.cfg = { ...DEFAULTS, ...values };
  if (!state.base) state.base = endpointsFor(state.cfg.server, state.cfg.accessToken).base;
  setChip(els.chipState, STATE_LABEL[state.ws] || state.ws, state.ws);
  setChip(
    els.chipSelf,
    state.selfID ? `机器人：${state.selfName || state.selfID}` : '机器人：未知',
  );
  setChip(els.chipModel, `模型：${state.modelSource || (values.llmModel || '未知')}`);
  if (els.statusError) {
    els.statusError.hidden = !state.wsError;
    els.statusError.textContent = state.wsError ? `最近一次错误：${state.wsError}` : '';
  }
  if (els.probeNote) {
    const probe = state.probe;
    els.probeNote.hidden = !probe;
    els.probeNote.textContent = probe
      ? `群 ${probe.group} · ${new Date(probe.at).toLocaleString('zh-CN', { hour12: false })}\n${probe.raw}`
      : '';
  }
  // 记忆与能量：机器人只在"回答完一条"之后才把它们写进群索引，一晚上说不了几句话，
  // 那两列就一直是空的。所以凡是索引里没有的，工坊自己读文件（只读最近 12 个群）。
  state.groupStats = await loadGroupStats([...state.groups.values()]
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)));
  renderGroups();
  // 记忆卡打开着就跟着刷新（机器人那边也可能刚写过一条）。
  if (state.memoryGroup) await renderMemoryCard();
  renderLog();
}

/** 每个群的记忆条数与能量；读不到就不显示（不猜）。 */
async function loadGroupStats(rows) {
  const out = new Map();
  if (!granted.has('storage')) return out;
  await Promise.all((rows || []).slice(0, 12).map(async (row) => {
    const id = cleanSegment(row && row.id);
    if (!id) return;
    const [energyRaw, notesRaw] = await Promise.all([
      readKeyText(energyKey(id)).catch(() => ''),
      readKeyText(notesKey(id)).catch(() => ''),
    ]);
    let energy = null;
    try {
      const parsed = JSON.parse(energyRaw || '{}');
      if (Number.isFinite(Number(parsed && parsed.value))) energy = Number(parsed.value);
    } catch {
      energy = null;
    }
    let notes = null;
    try {
      const parsed = JSON.parse(notesRaw || '[]');
      if (Array.isArray(parsed)) notes = parsed.length;
    } catch {
      notes = null;
    }
    out.set(id, { energy, notes });
  }));
  return out;
}

