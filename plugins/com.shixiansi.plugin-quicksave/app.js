'use strict';

/* 速记盒子（com.shixiansi.plugin-quicksave）—— 一个「一句话记下来」的盒子。
 *
 * ONE DOCUMENT, THREE FACES (decided by `init.surface`, never guessed):
 *
 *   surface.kind === 'surface'    浮层面里那一块紧凑卡片：输入框 + 「记下」 + 最近三条
 *   surface.slot === 'background' 桌宠挂的常驻无名帧：什么都不画，只答 `plugin.call` 的 add / recent
 *   anything else                 the control center's plugin page (slot 'workshop'): the full page
 *
 * 常驻帧存在的原因只有一个：别的插件（以后的模型工具也一样）要能在用户没打开任何界面的情况下把
 * 一句话丢进来、也能把最近几条读出去。`manifest.serves` 就是这份承诺，而只有常驻帧一定挂着。
 *
 * THE WRITER RULE, AND WHY IT IS ONLY A NARROWED WINDOW RATHER THAN A LOCK.
 * 盒子里只有一个 storage 键，而**有两个帧会写它**：卡片（用户敲的那一句）与常驻帧（`plugin.call`
 * 代别人写）。宿主没有给插件任何互斥手段——没有事务、没有 compare-and-set、没有锁。所以两个写者
 * 共用同一条纪律：**每次写之前现读一次 storage，改完立刻写回**，中间只隔一次往返。
 *
 * 这不是原子操作，代价写在 scratch/sprint/quicksave.md 的 open 里：两次写恰好交叉时，后写的那
 * 一份会覆盖前一份里刚加的那一条（一次，不是整盒）。真正的事故是另一种写法——把"我上次读到的那
 * 一份"当底稿写回去：常驻帧手里那份可能是一分钟前的，那会一次覆盖掉用户刚在卡片里记下的所有东西。
 * 所以 `readFresh` 的存在不是为了正确性上的洁癖，是为了让最坏情况从"丢一盒"缩成"丢一条"。
 *
 * 为什么卡片里没有 `events` 权限：这份权限表是这次冲刺定死的五项（storage / plugin.config /
 * pet.surface / pet.bubble / plugin.call），没有 `events`，所以收不到 `storage.changed`。
 * 于是卡片靠**15 秒兜底**那一拍去看别人写进来的新条目——手册 §7 允许的兜底粒度就是 15 秒，
 * 而 1 秒那种轮询在这个项目里是反模式（真机上它会把日志写成 99.5% 的轮询）。
 */

const els = {
  root: document.getElementById('root') || document.body,
  card: document.getElementById('card'),
  page: document.getElementById('page'),
  quick: document.getElementById('quick'),
  save: document.getElementById('save'),
  quickStatus: document.getElementById('quick-status'),
  recent: document.getElementById('recent'),
  note: document.getElementById('note'),
  tag: document.getElementById('tag'),
  add: document.getElementById('add'),
  query: document.getElementById('query'),
  count: document.getElementById('count'),
  pageStatus: document.getElementById('page-status'),
  pageHint: document.getElementById('page-hint'),
  all: document.getElementById('all'),
};

// 卡片显示几条、完整页显示几条。都是 `selectNotes` 的上限之内（手册 §6.8 那边 `recent` 的上限
// 是 50；页面自己也守同一个数，免得"页面上看得到、调用方读不到"这种两套规矩）。
const CARD_LIMIT = 3;
const PAGE_LIMIT = 50;

// 声明矩形（manifest.surface[0]）的副本。高度只有在"内容真的更高"时才请求长高，所以这两个数
// 与清单不一致的后果是"长不到该有的高度"或"请求被宿主夹住"——改清单时一起改这里。
const SURFACE_H = 132;
const SURFACE_MAX_H = 152;

const FALLBACK_MS = 15000;
const REQUEST_TIMEOUT_MS = 5000;

let role = 'boot'; // 'card' | 'page' | 'background' | 'boot'
let host = null; // init.host（{program, methods}），没有就是老宿主
let granted = new Set();
let settings = { maxItems: 500, sayOnSave: false, defaultTag: '' };
let book = { seq: 0, items: [] };
// 最近一次读失败的原因。留着它是为了让空列表**说真话**：读不到盒子和"盒子里真的没有东西"
// 在界面上长得一模一样（都是一行灰字），而这个插件最主要的失败方式正是"读不到"。
let readError = '';
let heightTimer = 0;
let lastHeight = SURFACE_H;
let idSeq = 0;
let wired = false;
let fallbackStarted = false;

// 还在飞的 `storage.set`：15 秒兜底那一拍要避开它们，否则"写入前发出的那次读"会晚于写入落地，
// 把屏幕上刚记下的那一条又抹掉（看起来像"记了但没记住"）。
const writes = new Set();
const awaiting = new Map(); // request id -> {resolve, timer}

// --- the bridge --------------------------------------------------------------

function postToHost(msg) {
  try {
    window.parent.postMessage(msg, '*');
  } catch {
    // 宿主把帧拆了；这里没有一件有意义的事可做。
  }
}

function nextId() {
  idSeq += 1;
  return 'q' + idSeq + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * 发一个请求，拿到一个**永远 resolve** 的 promise（回包里 `ok` 才是结论）。
 *
 * 为什么不 reject：每条调用点都要自己决定"被拒绝之后界面是什么样子"，而 `throw` 会让忘了 catch
 * 的地方变成一条 unhandled rejection——那在真机上等于"这一块永远停在半截，没有任何提示"。
 * 5 秒自己放弃，是因为宿主那边（`plugin.call` 的调用方）只有 30 秒预算；提前把原因说出来，
 * 比让它等到"等回答超时"这种说不清原因的失败好。
 */
function request(method, payload) {
  const id = nextId();
  const promise = new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      if (!awaiting.has(id)) return;
      awaiting.delete(id);
      writes.delete(id);
      resolve({ ok: false, error: method + ' 在 5 秒内没有回音' });
    }, REQUEST_TIMEOUT_MS);
    awaiting.set(id, { resolve, timer });
    postToHost({ v: 1, type: 'request', id, method, payload: payload === undefined ? {} : payload });
  });
  // 请求 id 挂在 promise 上：`writes` 那种"这次写入还在飞"的守卫要用它，而调用点不必再多存一个变量。
  promise.id = id;
  return promise;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

// --- settings ----------------------------------------------------------------

function boolOf(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function applySettings(values) {
  if (!values || typeof values !== 'object') return;
  settings = {
    maxItems: clampMaxItems(values.maxItems === undefined ? settings.maxItems : values.maxItems),
    sayOnSave: boolOf(values.sayOnSave === undefined ? settings.sayOnSave : values.sayOnSave),
    defaultTag: normalizeTag(values.defaultTag === undefined ? settings.defaultTag : values.defaultTag),
  };
  if (els.tag && settings.defaultTag && !els.tag.value) {
    // 完整页的标签框空着 = 用默认标签。把默认值写在占位符里，用户看得见"不填会发生什么"。
    els.tag.placeholder = settings.defaultTag + '（默认）';
  }
  updateHint();
}

/**
 * 控制中心里说不了话，就把这件事写出来（手册 §9：一个点了没反应的控件比没有控件更糟）。
 *
 * `bubble.say` 只有桌宠服务，而"记下之后说一句"是用户自己在设置里打开的——他在控制中心里打开
 * 这个开关，看到的应当是一句解释，而不是"开了却没反应"。
 */
function updateHint() {
  if (!els.pageHint) return;
  const mute = settings.sayOnSave && !servesMethod('bubble.say');
  els.pageHint.hidden = !mute;
  if (mute) {
    els.pageHint.textContent = '「记下之后让桌宠说一句」在控制中心里不会发生——那是桌宠那边的能力，这里只负责把话存好。';
  }
}

/**
 * 这个窗口服务不服务某个方法。优先问 `init.host.methods`（它就是宿主闸门那张表），退化时才按
 * `slot` 猜——手册 §5.2.1 那一节讲的就是"别背那张表"。
 */
const PET_ONLY = ['bubble.say', 'surface.show', 'surface.hide', 'surface.blocks', 'pet.badge', 'plugin.call'];

function servesMethod(method) {
  if (host && Array.isArray(host.methods)) return host.methods.includes(method);
  return !(role === 'page' && PET_ONLY.includes(method));
}

// --- reading and writing the box ---------------------------------------------

/**
 * 现读一份底稿。
 *
 * 读不到就**抛**，绝不当空盒子继续：`storage.get` 失败时宿主给的是 error 而不是空值，把 error 当
 * "" 继续，接下来那句 `storage.set` 就会把整盒覆盖成"只有这一条"——这个插件能造成的最大伤害，
 * 而且用户第二天才会发现。
 */
async function readFresh(why) {
  const answer = await request('storage.get', { key: 'notes-v1' });
  if (answer.ok !== true) {
    throw new Error('速记：读不到盒子（' + String(answer.error || '宿主没有回答') + '），' + why);
  }
  return parseBook(answer.result ? answer.result.value : '');
}

/** 存一份盒子，**等它落地**；写不进去就抛，绝不回一个自己都没把握的成功。 */
async function writeBook(next) {
  const value = serializeBook(next);
  if (utf8Bytes(value) > 1024 * 1024) {
    // 兜底：`fitBook` 的字节守卫本该让这里永远不成立。真成立了就是"回一条说得清的错误"，
    // 而不是让宿主回一句"值太大"——那时调用方（很可能是模型）只会以为保存成功了。
    throw new Error('速记：这一份超过了宿主单值 1 MiB 的上限，盒子没有变化');
  }
  const writing = request('storage.set', { key: 'notes-v1', value });
  writes.add(writing.id);
  const answer = await writing;
  if (answer.ok !== true) {
    throw new Error('速记：写入失败（' + String(answer.error || '宿主没有回答') + '），盒子没有变化');
  }
}

/**
 * 记一条。界面那一侧和 `plugin.call` 那一侧走的都是它——规则只有一份。
 *
 * 回包形状：`{id, at, total, merged}`（`evicted` 是给界面/日志用的额外信息，调用方可以不管）。
 */
async function addNote(payload) {
  if (!granted.has('storage')) throw new Error('未获权限 storage：这个盒子现在既记不住也翻不出来');
  const input = payload && typeof payload === 'object' ? payload : {};
  if (input.text !== undefined && input.text !== null && typeof input.text !== 'string') {
    throw new Error('add：text 必须是字符串（必填，一句话）');
  }
  const text = normalizeText(input.text);
  if (!text) throw new Error('add：text 为空（必填，去掉首尾空白后不能是空字符串）');
  const runes = textRunes(text);
  if (runes > TEXT_MAX) throw new Error('add：text 太长（' + runes + ' 字符，上限 ' + TEXT_MAX + '）');

  // 标签：没给（或缺席）就用设置里的默认标签；空串也算"没给"，这样界面上那个空着的输入框
  // 与调用方漏掉的字段是同一个意思。
  if (input.tag !== undefined && input.tag !== null && typeof input.tag !== 'string') {
    throw new Error('add：tag 必须是字符串（可选，例如 "工作"）');
  }
  const tag = normalizeTag(input.tag) || settings.defaultTag;
  const tagRunes = textRunes(tag);
  if (tagRunes > TAG_MAX) throw new Error('add：tag 太长（' + tagRunes + ' 字符，上限 ' + TAG_MAX + '）');

  // 写前现读（见文件头）。这一步之后到 `storage.set` 之间只有一次往返。
  const fresh = await readFresh('看不见底稿就不写');
  const result = applyAdd(fresh, { text, tag, at: Date.now() }, settings.maxItems);
  await writeBook(fresh);

  // 内存里那份也只在**写成功之后**才更新：否则卡片会显示一条并不在文件里的速记。
  book = fresh;
  readError = '';
  render();
  maybeSay(result);
  return { id: result.id, at: result.at, total: result.total, merged: result.merged };
}

/** `recent` 的规则外壳：参数校验（说清楚哪里不对）+ 现读 + 交给 `recentFrom`。 */
async function recentNotes(payload) {
  if (!granted.has('storage')) throw new Error('未获权限 storage：这个盒子现在翻不出来');
  const input = payload && typeof payload === 'object' ? payload : {};
  let limit = RECENT_DEFAULT;
  if (input.limit !== undefined && input.limit !== null) {
    if (typeof input.limit !== 'number' || !Number.isFinite(input.limit)) {
      throw new Error('recent：limit 必须是 1..' + RECENT_MAX + ' 的整数（缺省 ' + RECENT_DEFAULT + '），收到 ' + JSON.stringify(input.limit));
    }
    // 超出上限按上限给：要 200 条的人其实是要"尽量多"，而回包里带着 total，他看得见自己被截了。
    limit = Math.min(RECENT_MAX, Math.max(1, Math.floor(input.limit)));
  }
  if (input.query !== undefined && input.query !== null && typeof input.query !== 'string') {
    throw new Error('recent：query 必须是字符串（大小写不敏感的子串）');
  }
  if (input.tag !== undefined && input.tag !== null && typeof input.tag !== 'string') {
    throw new Error('recent：tag 必须是字符串（可选，例如 "工作"）');
  }
  const fresh = await readFresh('这一次读不到就没有答案');
  return recentFrom(fresh, { limit, query: input.query || '', tag: input.tag || '' });
}

/** 存好之后，如果用户在设置里要了，就让桌宠说一句——**文字里带条数**。 */
function maybeSay(result) {
  if (!settings.sayOnSave) return;
  if (!granted.has('pet.bubble')) return;
  if (!servesMethod('bubble.say')) return; // 控制中心：没有宠物，`updateHint` 已经把这件事写出来了
  const head = result.merged ? '又记了一次，盒子' : '记下了，盒子';
  void request('bubble.say', { text: head + '里现在 ' + result.total + ' 条' });
}

// --- answering other plugins (`plugin.call`) ---------------------------------

/**
 * 答一次 `plugin.call`。三种结局都要回一条 call-result——**包括「我不认识这个方法」**：
 * 不回，调用方只能等到 30 秒超时，而超时是唯一说不清原因的失败。
 */
function postCallResult(ticket, ok, value) {
  const message = { v: 1, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

const CALL_HANDLERS = {
  add: (payload) => addNote(payload),
  recent: (payload) => recentNotes(payload),
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      '速记盒子不认识方法 ' + (method || '(空)') + '：它只回答 ' + Object.keys(CALL_HANDLERS).join(' / ')));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

// --- painting ----------------------------------------------------------------

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 卡片里只要时刻；完整页在不是今天的时候还要日子。 */
function clockOf(at, withDay) {
  const d = new Date(Number(at) || 0);
  if (Number.isNaN(d.getTime())) return '';
  const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (!withDay) return clock;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? '今天 ' + clock : pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + clock;
}

function setStatus(text, tone) {
  const target = role === 'page' ? els.pageStatus : els.quickStatus;
  if (!target) return;
  target.textContent = String(text === undefined || text === null ? '' : text);
  if (tone) target.dataset.tone = tone;
  else delete target.dataset.tone;
}

function tagChip(tag) {
  const chip = document.createElement('span');
  chip.className = 'tag';
  chip.textContent = '#' + tag;
  return chip;
}

/** 卡片里的一条：标签 · 一句话（一行，多了省略） · 时刻。 */
function cardRow(item) {
  const row = document.createElement('li');
  row.className = 'recent-row';
  if (item.tag) row.appendChild(tagChip(item.tag));
  const text = document.createElement('span');
  text.className = 'recent-text';
  // textContent 而不是 innerHTML：速记里出现什么字符（`<b>`、`&`）都不该变成标记。
  text.textContent = item.text;
  text.title = item.text;
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = clockOf(item.at, false);
  row.append(text, when);
  return row;
}

function emptyRow(text, className) {
  const row = document.createElement('li');
  row.className = className || 'empty';
  row.textContent = text;
  return row;
}

function render() {
  if (role === 'card') renderCard();
  else if (role === 'page') renderPage();
}

/** 空列表要说的那句话：读不到 ≠ 一条都没有（两者在界面上都是一行灰字）。 */
function emptyText(emptyHint) {
  if (readError) return '读不到盒子：' + readError;
  if (!granted.has('storage')) return '未获权限 storage：记不了。';
  return emptyHint;
}

function renderCard() {
  if (!els.recent) return;
  const picked = selectNotes(book.items, { limit: CARD_LIMIT });
  els.recent.replaceChildren();
  if (picked.items.length === 0) {
    els.recent.appendChild(emptyRow(emptyText('还没有速记。'), 'empty'));
  } else {
    for (const item of picked.items) els.recent.appendChild(cardRow(item));
  }
  scheduleHeight();
}

function pageRow(item) {
  const row = document.createElement('li');
  row.className = 'note-row';
  const head = document.createElement('div');
  head.className = 'note-head';
  if (item.tag) head.appendChild(tagChip(item.tag));
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = clockOf(item.at, true);
  head.appendChild(when);
  const text = document.createElement('p');
  text.className = 'note-text';
  text.textContent = item.text;
  row.append(head, text);
  return row;
}

function renderPage() {
  const query = els.query ? els.query.value : '';
  const picked = selectNotes(book.items, { limit: PAGE_LIMIT, query });
  if (els.all) {
    els.all.replaceChildren();
    if (picked.items.length === 0) {
      els.all.appendChild(emptyRow(emptyText(query.trim() ? '没有含这几个字的速记。' : '还没有速记。上面写一句试试。'), 'empty'));
    } else {
      for (const item of picked.items) els.all.appendChild(pageRow(item));
    }
    if (picked.limited > picked.items.length) {
      els.all.appendChild(emptyRow('只显示最近 ' + picked.items.length + ' 条（共 ' + picked.limited + ' 条命中）', 'more'));
    }
  }
  if (els.count) {
    const total = book.items.length;
    els.count.textContent = query.trim()
      ? '找到 ' + picked.limited + ' 条 / 共 ' + total + ' 条'
      : '共 ' + total + ' 条';
  }
}

/**
 * 卡片长高（`surface.blocks`）。
 *
 * 卡片的高度是**声明死的**（manifest 的 `h`），内容一多就被裁掉，而且不会报错——手册 §8.2b 那五
 * 次翻车就是这么来的。所以内容一变就重新量一次，每次都把"这是现在的高度"报上去（宿主那边是
 * "最后一条生效"，重复发送无害）。只有声明了 `maxH` 的块会被应用。
 *
 * 120ms 是防抖而不是节流：到期一定会发，不会像节流那样把一次真需要的高度请求丢掉。
 * 量的是**装内容的那一层**（`#card` 的 scrollHeight 含内边距），不是 `flex: 1` 的容器——
 * 后者的 scrollHeight 恒等于帧高，量它永远得到"当前高度"。
 */
function scheduleHeight() {
  if (role !== 'card') return;
  if (!granted.has('pet.surface')) return;
  if (!servesMethod('surface.blocks')) return;
  window.clearTimeout(heightTimer);
  heightTimer = window.setTimeout(() => {
    if (!els.card) return;
    // `scrollHeight` 已经含内边距，所以不再加任何补偿量：加了 2 就会让"内容刚好放得下"的那一屏
    // 每次都请求长高 2px，卡片在每次打开时都跳一下。
    const want = Math.max(SURFACE_H, Math.min(SURFACE_MAX_H, Math.ceil(els.card.scrollHeight)));
    if (want === lastHeight) return;
    lastHeight = want;
    void request('surface.blocks', { sizes: { 0: want } });
  }, 120);
}

// --- the two interfaces ------------------------------------------------------

function messageOf(err) {
  return String(err && err.message ? err.message : err);
}

/** 保存成功才清空草稿：丢了用户刚敲的那句话，比丢了这一次保存更让人恼火。 */
async function saveFromCard() {
  if (!els.quick || !els.save) return;
  const draft = els.quick.value;
  const text = normalizeText(draft);
  if (!text) {
    setStatus('先写一句话，再按「记下」。', 'bad');
    els.quick.focus();
    return;
  }
  els.save.disabled = true;
  try {
    const result = await addNote({ text });
    els.quick.value = '';
    setStatus(result.merged ? '又记了一次，共 ' + result.total + ' 条' : '记下了，共 ' + result.total + ' 条');
    els.quick.focus();
  } catch (err) {
    // 草稿**留在输入框里**：被拒绝（没授权、写不进去）时用户最需要的正是"别把我这句话弄丢"。
    setStatus(messageOf(err) + '（这句话还在输入框里）', 'bad');
  } finally {
    els.save.disabled = false;
  }
}

async function saveFromPage() {
  if (!els.note || !els.add) return;
  const draft = els.note.value;
  const text = normalizeText(draft);
  if (!text) {
    setStatus('先写一句话，再按「记下」。', 'bad');
    els.note.focus();
    return;
  }
  els.add.disabled = true;
  try {
    const result = await addNote({ text, tag: els.tag ? els.tag.value : '' });
    els.note.value = '';
    setStatus(result.merged ? '又记了一次，共 ' + result.total + ' 条' : '记下了，共 ' + result.total + ' 条');
    els.note.focus();
  } catch (err) {
    setStatus(messageOf(err) + '（这句话还在输入框里）', 'bad');
  } finally {
    els.add.disabled = false;
  }
}

/** 没授权时不是"点了报错"，而是"控件本来就是禁用的，并写清楚为什么"。 */
function degradeWithoutStorage() {
  const why = role === 'background' ? '' : '未获权限 storage：这个小盒子现在记不住东西。在控制中心的「插件」页里重新授权之后再试。';
  if (why) setStatus(why, 'bad');
  for (const node of [els.quick, els.save, els.note, els.add]) {
    if (!node) continue;
    node.disabled = true;
    if (why) node.title = why;
  }
  render();
}

function wire() {
  if (wired) return;
  wired = true;
  if (els.save) els.save.addEventListener('click', () => void saveFromCard());
  if (els.add) els.add.addEventListener('click', () => void saveFromPage());
  for (const [field, run] of [[els.quick, saveFromCard], [els.note, saveFromPage]]) {
    if (!field) continue;
    field.addEventListener('keydown', (ev) => {
      // Enter 就是"记下"（这是这个盒子唯一的输入动作，不该逼用户去点按钮）。
      // IME 组字中的 Enter 是在选词，不是在提交——`isComposing` 挡掉它，否则中文用户每打一个词
      // 就会多出一条半截的速记。
      if (ev.key !== 'Enter' || ev.isComposing) return;
      ev.preventDefault();
      void run();
    });
  }
  if (els.query) els.query.addEventListener('input', () => render());
}

// --- the bridge: init / responses / events -----------------------------------

async function mountFromHost() {
  wire();
  if (role !== 'background') {
    for (const node of [els.quick, els.save, els.note, els.add]) if (node) node.disabled = false;
    setStatus('');
  }
  if (granted.has('plugin.config')) {
    const answer = await request('config.get', {});
    if (answer.ok === true) applySettings(answer.result && answer.result.values);
  }
  if (!granted.has('storage')) {
    degradeWithoutStorage();
    return;
  }
  const answer = await request('storage.get', { key: 'notes-v1' });
  if (answer.ok !== true) {
    // 运行时失败不是"没授权"：控件留着能用（宿主可能只是这一拍忙），错误原样显示。
    readError = String(answer.error || '读不到盒子');
    if (role !== 'background') setStatus(readError, 'bad');
    render();
    return;
  }
  readError = '';
  book = parseBook(answer.result ? answer.result.value : '');
  render();
  if (role === 'page') updateHint();
}

function onInit(data) {
  applyTheme(data && data.theme);
  granted = new Set((data && data.granted) || []);
  host = data && data.host && typeof data.host === 'object' ? data.host : null;

  const surface = (data && data.surface) || {};
  // `kind` 不能拿来判断窗口（常驻帧的 kind 也是 'panel'）；本体帧才是两个都说明的那种。
  if (surface.kind === 'surface') role = 'card';
  else if (surface.slot === 'background') role = 'background';
  else role = 'page';

  els.root.className = 'view-' + role;
  els.root.dataset.surface = surface.kind || 'panel';
  if (els.card) els.card.hidden = role !== 'card';
  if (els.page) els.page.hidden = role !== 'page';
  if (role === 'card' && els.quick) els.quick.focus();

  // `init` 之后才发请求（铁律 2）。三条路都从 `mountFromHost` 走，授权缺哪一项就在那里降级。
  void mountFromHost().catch((err) => {
    if (role !== 'background') setStatus('速记盒子起不来：' + messageOf(err), 'bad');
  });

  if (role === 'card') startFallbackRead();
}

/**
 * 15 秒兜底那一拍：卡片是浮层面，没有 `events` 权限（拿不到 `storage.changed`），而别人用
 * `plugin.call` 写进来的那一条不会推过来。手册 §7 允许的兜底粒度就是 15 秒；1 秒那种轮询在这个
 * 项目里是反模式（真机上它把日志写成了 99.5% 的轮询）。
 */
function startFallbackRead() {
  if (!granted.has('storage')) return;
  if (fallbackStarted) return; // 授权变了宿主会重挂帧；同一个文档里再挂一个 interval 只会是重复的读
  fallbackStarted = true;
  window.setInterval(() => {
    // 自己那次写入还在飞的时候不读：读回来的会是写入前的那一份（见 writes 的注释）。
    if (writes.size > 0) return;
    void request('storage.get', { key: 'notes-v1' }).then((answer) => {
      if (answer.ok !== true) return;
      const next = parseBook(answer.result ? answer.result.value : '');
      const recovering = readError !== '';
      readError = '';
      if (!recovering && serializeBook(next) === serializeBook(book)) return;
      book = next;
      render();
    });
  }, FALLBACK_MS);
}

function onResponse(data) {
  if (data && data.id) writes.delete(data.id);
  const waiting = data && data.id ? awaiting.get(data.id) : null;
  if (waiting) {
    awaiting.delete(data.id);
    window.clearTimeout(waiting.timer);
    waiting.resolve(data);
    return;
  }
  // 没人等它（迟到的回包，或者那次调用点已经不在）：安全丢弃。
  if (!data || data.ok === true) return;
  if (role === 'background') return;
  // 失败就是一条给人看的中文句子（手册 §5.3 第 5 条）：原样显示，别包装成"出错了"。
  setStatus(String(data.error || '宿主拒绝了这次调用'), 'bad');
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.v !== 1) return;
  switch (data.type) {
    case 'init':
      onInit(data);
      break;
    case 'theme':
      applyTheme(data.theme);
      break;
    case 'response':
      onResponse(data);
      break;
    case 'call':
      // 不按 role 挡：常驻帧只有声明了 background 才有，但真有帧在的时候，能答就该答——
      // 挡掉的结果是调用方白等 30 秒（宿主不替谁答）。
      void onCall(data);
      break;
    default:
      // 宿主以后会加消息类型；不认识的 type 一律忽略（手册 §5.3）。
      break;
  }
}

window.addEventListener('message', onMessage);

// 握手第一步。宿主会回恰好一条 `init`；监听器必须已经装好（铁律 1）。
postToHost({ v: 1, type: 'ready' });
