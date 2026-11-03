// The todo plugin (1.3.0).
//
// It is a plain module in a sandboxed iframe: it can address exactly one thing in the outside
// world, its parent, and only with the message types of the bridge protocol (ready / init /
// request / response / event). No fetch, no localStorage, no file access - the host's `storage`
// capability is where the list lives.
//
// ONE document, TWO jobs, and the host mounts it twice:
//
//   surface.kind === 'surface'                  the list, in the column beside the pet
//   surface.kind === 'panel' + slot 'background' a HEADLESS frame that only runs the reminders
//
// The second one exists because a reminder has to fire while no interface is open, and the host
// only delivers events to a frame it mounted. It draws nothing (`body.bg` in style.css) and takes
// no clicks; it wakes up once a minute and decides whether it is time to speak.
//
// Why a surface and not a panel tab: the host's panel is going away. The rectangle the panel used
// to fill - the column beside the pet - is what a plugin declares now.
//
// 1.1.0: THE LIST IS THIS PLUGIN'S. It used to sit in the host's own store, reached through the
// `todos.*` capabilities, because the pomodoro is a second consumer of the same list and it had not
// moved yet. Both halves moved now: the data lives in this plugin's `storage` (key `todos-v1`), and
// the pomodoro reads a SNAPSHOT this plugin publishes to `share` (`todo-list`). The host's
// `todos.*` methods and both `todos.*` permissions are gone with it.
//
// One rule follows from owning the data, and it is load-bearing: on its OWN initiative the surface
// frame is the only writer. The headless frame re-reads `storage` before every reminder tick and
// never writes there - two writers to one key, one of them on a timer, would be a
// read-modify-write race over the whole list.
//
// 1.3.0 bends that rule in exactly one place, and only because somebody else is waiting. `serves`
// used to be just `stats`, so "把会议纪要里的待办加进列表" was impossible for any other plugin to
// do: there was no `add_task`. The host answers a `plugin.call` from the HEADLESS frame (it is the
// one that is always mounted), so that frame now has to write - and it does it the only way that
// keeps the rule's reason intact: it re-reads `storage` immediately before every write, and the
// write is not on a timer, it is the thing a caller asked for. Reminder ticks still only read.

const els = {
  root: document.getElementById('root') || document.body,
  list: document.getElementById('list'),
  status: document.getElementById('status'),
  title: document.getElementById('title'),
  add: document.getElementById('add'),
};

// The storage keys the plugin owns. The host's storage.set/get take a KEY, not a path; the plugin
// names its own files and the host keeps them in its private directory.
//
// The todos themselves are here now (`todos-v1`). Migration from the host's old `todos.json` happens
// once, on the host side, before this plugin ever runs against the new key - see
// migrateTodosIntoPlugin in the host repo. An empty value therefore means "a fresh install", not
// "the migration was lost".
const TODOS_KEY = 'todos-v1';
const LAST_SAID_KEY = 'reminded-at-v1';

// The name the snapshot is published under, in `share`. The pomodoro plugin declares
// `shareRead: ["com.shixiansi.plugin-todo/todo-list"]` and reads it with `share.get`.
const SHARE_LIST = 'todo-list';

// Settings the user edits in the market program (`config` in the manifest). Defaults match the
// manifest, so a frame that never gets an answer still behaves.
let settings = {
  // ON: the host's scheduler is gone (see the retired block in app_reminder.go), so this is the only
  // thing that reminds - the double-fire that made it default to false is what was deleted.
  remindEnabled: true,
  remindIntervalMin: 30,
  remindJitterMin: 3,
  remindFrom: '09:00',
  remindTo: '22:00',
  remindMaxItems: 3,
};

let initialised = false;
let granted = new Set();
// Which of the two jobs this frame has.
let role = 'boot'; // 'list' | 'background' | 'boot'
let todos = [];
let lastSaid = 0;
let pendingConfig = null;
let pendingSaid = null;
let seq = 0;

function nextId() {
  seq += 1;
  return `t${seq}-${Date.now().toString(36)}`;
}

function postToHost(msg) {
  try {
    window.parent.postMessage(msg, '*');
  } catch {
    // The host tore the iframe down; there is nothing sensible to do.
  }
}

/** Sends a host capability request. Refuses before the handshake: the granted set is unknown. */
function request(method, payload) {
  if (!initialised) return null;
  const id = nextId();
  postToHost({ v: 1, type: 'request', id, method, payload });
  return id;
}

/**
 * `request` 的等待版：**只**给回答 `plugin.call` 的那三条用（下面的 add_task / toggle / list）。
 *
 * 为什么界面那一侧不改成它：那里（读→画、写→画）靠事件收敛就够了，"没等到答案"的表现只是界面
 * 晚一拍。而**代别人写数据**不是同一件事——`add_task` 如果对着一次被拒绝的 `storage.set` 回一句
 * `{id, text, total, open}`，调用方（很可能是个模型）会认为事情办妥了，而用户那边什么都没多出来。
 * 这正是 1.3.0 之前没有这个能力时最该避免的那种"看着能用、其实静默失效"的接口。
 *
 * 5 秒放弃：调用方那边是 30 秒预算（手册 §6.8），我们提前把原因说出来，而不是让它等到"等回答
 * 超时"——那是唯一说不清原因的失败，也是本文件顶上 postCallResult 注释里那条规矩的另一半。
 */
const awaited = new Map(); // request id -> { resolve, timer }

function requestAsync(method, payload) {
  return new Promise((resolve) => {
    if (!initialised) {
      resolve({ ok: false, error: '还没有握手' });
      return;
    }
    const id = nextId();
    // 写入的 id 也进 `writes`：界面那一侧的轮询与 `storage.changed` 靠这个集合避开"读回来的还是
    // 写入前的那一份"（见 writes 的注释）。代别人写的那次 set 同样在飞，守卫没有理由不成立。
    if (method === 'storage.set') writes.add(id);
    const timer = window.setTimeout(() => {
      if (!awaited.has(id)) return;
      awaited.delete(id);
      writes.delete(id);
      resolve({ ok: false, error: method + ' 在 5 秒内没有回音' });
    }, 5000);
    awaited.set(id, { resolve, timer });
    postToHost({ v: 1, type: 'request', id, method, payload });
  });
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

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      '待办不认识方法 ' + (method || '(空)') + '：它只回答 ' + Object.keys(CALL_HANDLERS).join(' / ')));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

/**
 * `stats` —— 给看板插件的四个数（完成率卡片）。
 *
 * 只读：不写 storage、不发气泡、不碰界面。答话的是**常驻帧**（宿主的规矩：background 帧优先
 * 答一个 plugin.call），它每次提醒 tick 都会重读列表；这里再顺手读一次，让下一次问话是新的。
 * 看板 30 秒问一次，所以一份最多一分钟前的列表对「完成率」这个粒度够用——为它加一套
 * promise 化的 storage 等待，换来的是同一张卡片早 0.3 秒出现，不值得。
 * （1.3.0 的写方法**等**，因为它们的回包在说"文件里现在是什么"，差半秒就是另一个答案；
 *  `stats` 说的是完成率，差半分钟没有人在意。两种做法并存是刻意的，别互相统一。）
 */
function handleStats() {
  loadTodos();
  const total = todos.length;
  const done = todos.filter((t) => t.done === true).length;
  const open = total - done;
  // `due` 是本插件自己的自由字段（界面目前不写它，只留给手改/导入的数据）：非空即「有期限」。
  const dueToday = todos.filter((t) => t.done !== true && String(t.due || '').trim() !== '').length;
  return {
    total,
    done,
    open,
    dueToday,
    completionRate: total === 0 ? 0 : Math.round((done / total) * 100),
    at: Date.now(),
  };
}

const CALL_HANDLERS = {
  stats: handleStats,
  add_task: handleAddTask,
  toggle: handleToggle,
  list: handleList,
};

// --- 代别的插件读写（`serves`: add_task / toggle / list，1.3.0） --------------
//
// 这三条是生态里最贵的那块空洞的另一半：49 个 `serves` 里带写入的只有六个，而待办只 serve
// `stats`，于是"把会议纪要里的待办加进列表""问一句天气然后建个提醒"这类最常见的助手动作，
// 在 1.3.0 之前根本做不到（宿主机制够用，缺的只是这三个方法）。
//
// 形状（调用方拿到的就是这个，回包原样经 `plugin.call` 传回）：
//
//   add_task { text, due? }   → { id, text, total, open }
//   toggle   { id?, index? }  → { id, done, open }
//   list     { filter? }      → { items: [{ id, text, done, due }], total, open }   // filter: open|done|all，缺省 open
//
// 三条共同的事：
// - **只动 storage，不碰界面**：写完不弹气泡、不重画。宿主每 2 秒扫一次私有目录，
//   `storage.changed` 会让所有挂着的文档自己重读；在这里顺手画一次只是和别人的写入抢重绘。
// - **底稿现读**（readForWrite）：答话的是常驻帧，它手里那份 `todos` 是上一次提醒 tick 读的——最多
//   60 秒前的。拿它当底稿写回去，会把用户刚在浮层面里删掉的行**写活过来**。
// - **失败要说话**：未授权、读不到、写不进都抛一条点名原因的中文错误（onCall 会把它变成调用方的
//   error 文本），绝不回一个自己都没有把握的成功。

function openCount(list) {
  return list.filter((t) => t.done !== true).length;
}

/**
 * 现读一份列表当底稿；读不到就抛，**不要**当成空列表。
 *
 * 这一格是这三条方法里最要紧的：`storage.get` 失败时宿主给的是 error，不是空字符串。把 error
 * 当 "" 继续，`parseTodos` 得到 []，接着 `storage.set([新的一条])` 就把**整张列表覆盖成一条**——
 * 这个接口能造成的最大伤害，而且用户第二天才会发现。
 */
async function readForWrite() {
  const answer = await requestAsync('storage.get', { key: TODOS_KEY });
  if (!answer || answer.ok !== true) {
    const why = (answer && answer.error) || '宿主没有回答';
    throw new Error('待办：读不到列表（' + why + '），看不见底稿就不写');
  }
  return parseTodos(answer.result ? answer.result.value : '');
}

/**
 * 存一份列表，**等它落地**，成功了才发布快照。
 *
 * 与 `saveTodos` 的两处差别都是同一句「代别人写」的后果：
 * - 它等答复：回包里的 total/open 是在说"文件里现在是什么"，写入被拒时那个数字就是假的；
 * - 它成功后才 `publishList()`：`saveTodos` 无条件发布，因为界面那一侧的每次写都伴随一次重画
 *   （用户看得见失败，快照最多领先一拍）。这里如果 set 被拒还发快照，番茄钟的挑选器就会对一个
 *   storage 里并不存在的列表做选择——两个读者各信一份。
 */
async function writeThrough(list) {
  const answer = await requestAsync('storage.set', { key: TODOS_KEY, value: JSON.stringify(list) });
  if (!answer || answer.ok !== true) {
    const why = (answer && answer.error) || '宿主没有回答';
    throw new Error('待办：写入 storage 失败（' + why + '），列表没有变化');
  }
  // 内存里的那份也只在**写入成功之后**才更新：否则常驻帧的提醒 tick 会去提一条并不存在的待办。
  todos = list;
  publishList();
  return list;
}

/**
 * `add_task` —— 别人替用户记一件事（会议纪要里抽出来的待办、一句话提醒）。
 *
 * `text` 必填，去首尾空白后 1..200 字符；`due` 可选，**自由字符串**：这个插件本来就有 `due`
 * 字段，界面不写它，只留给手改/导入的数据，所以这里也不解释它的格式（"明天下午"和
 * "2026-11-05 18:00" 都是合法的，用户和调用方自己约定）。把它当日期解析一次，只会在遇到
 * 第一个不认识的写法时静默丢掉用户的意思。
 *
 * 上限 200 是个不需要解释的数字：一条待办长到 200 字以上，问题在调用方那边（它把一段正文当成了
 * 标题），而截断比拒绝更坏——用户会看到一条从中间断掉的句子。
 */
async function handleAddTask(payload) {
  if (!granted.has('storage')) throw new Error('add_task：未获权限 storage，写不了待办');
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) throw new Error('add_task：text 为空（必填，去掉首尾空白后不能是空字符串）');
  if (text.length > 200) throw new Error('add_task：text 太长（' + text.length + ' 字符，上限 200）');
  if (payload.due !== undefined && payload.due !== null && typeof payload.due !== 'string') {
    throw new Error('add_task：due 必须是字符串（自由文本，例如 "2026-11-05 18:00"）');
  }
  const due = typeof payload.due === 'string' ? payload.due.trim() : '';

  const list = await readForWrite();
  // id 用本插件自己的那一套（nextTodoId，和界面加的那条一模一样），不另造一套：一份文件里两种
  // 形状的 id 混着，就是下一个"按 id 找不到"的坑。
  const item = {
    id: nextTodoId(),
    title: text,
    done: false,
    due,
    createdAt: new Date().toISOString(),
  };
  list.push(item);
  await writeThrough(list);
  // total/open 从刚写进去的那份列表算：这才是"存完立刻算新的"的意思（不是把旧数字加一）。
  return { id: item.id, text: item.title, total: list.length, open: openCount(list) };
}

/**
 * `toggle` —— 翻一条的完成状态。
 *
 * `id` 精确定位（推荐：列表顺序会变，id 不会）；`index` 只是兼容路径，0 基。两个都给时按 `id`
 * 走，因为那是唯一不会因为"别人刚插了一条"而翻错行的定位方式。
 *
 * 找不到时**报错**而不是静默成功：一个回了 `{done:true}` 却什么都没翻的接口，调用方会把它写进
 * 摘要里，而用户的列表一动没动——这种错没人会去查。
 */
async function handleToggle(payload) {
  if (!granted.has('storage')) throw new Error('toggle：未获权限 storage，改不了待办');
  const wanted = typeof payload.id === 'string' ? payload.id.trim() : '';
  const hasIndex = payload.index !== undefined && payload.index !== null;
  if (!wanted && !hasIndex) {
    throw new Error('toggle：需要 id（推荐）或 index（0 基），两个都没给就不知道该翻哪一条');
  }
  // 形状先查、列表后读：`index: -1` 或 `"一"` 这种不用知道列表有多长就能拒绝，而一次无谓的
  // storage 读会把时间花在一个已经注定失败的调用上（调用方那边只有 30 秒）。
  if (!wanted) {
    const index = payload.index;
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('toggle：index 必须是 0 基的非负整数，收到 ' + JSON.stringify(index));
    }
  }

  const list = await readForWrite();
  let at = -1;
  if (wanted) {
    at = list.findIndex((t) => t.id === wanted);
    if (at < 0) {
      throw new Error('toggle：找不到 id 为 ' + wanted + ' 的待办（列表里现在有 ' + list.length + ' 条）');
    }
  } else {
    // 越界只能读完之后才判：列表有多长是文件说了算，不是调用方。
    if (payload.index >= list.length) {
      throw new Error('toggle：index ' + payload.index + ' 越界（共 ' + list.length + ' 条，0 基最大 ' + (list.length - 1) + '）');
    }
    at = payload.index;
  }

  const next = { ...list[at], done: list[at].done !== true };
  list[at] = next;
  await writeThrough(list);
  return { id: next.id, done: next.done, open: openCount(list) };
}

const LIST_FILTERS = ['open', 'done', 'all'];

/**
 * `list` —— 把列表读出来。
 *
 * **只读**：不写 storage、不发气泡、不碰界面，连 `todos` 都不改。这份读回来的列表是给调用方的
 * 一份快照，塞回常驻帧的内存里会让它和界面那一侧的 DOM 短暂不一致（而这里没有权限去重画）。
 *
 * 与 `stats` 不同，这里**等**读的答复：`stats` 报的是完成率，"一分钟前"和"现在"是同一个数；
 * 而 `list` 的全部内容就是"现在列表上有什么"，拿一份 60 秒前的副本答它，就是下一个"看着对、
 * 其实是错的"接口。
 *
 * `filter` 只认三个值，别的一律报错：一个拼错的 filter 如果被悄悄当成缺省 `open`，读的人会以为
 * "完成的任务都丢了"——那是数据事故的观感，而实际只是拼错一个字。
 */
async function handleList(payload) {
  if (!granted.has('storage')) throw new Error('list：未获权限 storage，读不到待办');
  const raw = payload.filter === undefined || payload.filter === null ? 'open' : payload.filter;
  const filter = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!LIST_FILTERS.includes(filter)) {
    throw new Error('list：filter 只认 ' + LIST_FILTERS.join(' / ') + '（缺省 open），收到 ' + JSON.stringify(raw));
  }

  const list = await readForWrite();
  const items = list
    .filter((t) => (filter === 'all' ? true : filter === 'done' ? t.done === true : t.done !== true))
    // 对外叫 `text`，内部叫 `title`：这是 1.1.0 之前宿主那份 `todos.json` 的字段名留下的，改内部
    // 名字要动已经装好的用户的文件，而对外统一成 `text` 是给调用方的接口——两者在这里对上。
    .map((t) => ({ id: t.id, text: t.title, done: t.done === true, due: t.due }));
  return { items, total: list.length, open: openCount(list) };
}

// --- the list ---------------------------------------------------------------

// The request id whose response carries the stored list, so its answer can be told apart from the
// others.
let pendingList = null;

/**
 * The ids of `storage.set` calls still waiting for an answer.
 *
 * They matter because the list role POLLS now (see startListPoll): two documents can be open on
 * one list - the pet's surface and the control center's plugin page - so an un-refreshed copy
 * would silently disagree with the other window. The poll is paused while a write of our own is
 * in flight, because a read that was issued BEFORE the write would otherwise land after it and
 * put the older list back on screen.
 */
const writes = new Set();

/**
 * Reads the list out of this plugin's own storage.
 *
 * Called on every mount and, in the headless frame, before every reminder tick: the surface is the
 * only writer ON ITS OWN INITIATIVE (1.3.0's call handlers write too, and they re-read first - see
 * readForWrite), so the headless frame's copy is at most one tick (60s) old, and a reminder goes out
 * every 30 minutes. Re-reading there is what replaces the host's `todos.changed` event.
 */
function loadTodos() {
  if (!granted.has('storage')) return;
  pendingList = request('storage.get', { key: TODOS_KEY });
}

/**
 * Clamps whatever came out of the file into the shape the list renders from.
 *
 * A corrupt value falls back to an EMPTY list rather than throwing inside the bridge's message
 * handler: the file is this plugin's own, and an unreadable one must not leave the frame mute for
 * the rest of the session. (`todos.json`'s .bak-and-warn rule is the host's, for files the user
 * would care about; this one is derived data that the next write repairs.)
 */
function parseTodos(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string')
      .map((t) => ({
        id: t.id,
        title: t.title,
        done: t.done === true,
        due: typeof t.due === 'string' ? t.due : '',
      }));
  } catch {
    return [];
  }
}

/**
 * Writes the list back, then publishes the snapshot other plugins read.
 *
 * `storage` is the authoritative copy and this plugin is its only writer; `share` is a snapshot for
 * the pomodoro's picker (which needs a todo to attach a session to). Publishing on EVERY write is
 * what keeps the second reader at most one edit behind, and publishing on the first write is what
 * makes a fresh install work at all: `share.get` before any write answers with an empty value, and
 * "nobody published yet" and "the list is empty" are the same answer to the picker.
 */
function saveTodos() {
  if (!granted.has('storage')) return;
  const id = request('storage.set', { key: TODOS_KEY, value: JSON.stringify(todos) });
  if (id) writes.add(id);
  publishList();
}

function publishList() {
  if (!granted.has('plugin.share')) return;
  request('share.set', { name: SHARE_LIST, value: JSON.stringify(todos) });
}

function nextTodoId() {
  return 'todo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/**
 * Draws the list.
 *
 * `replaceChildren` rather than a diff: the list is small (tens of items), and a full redraw is
 * the one version that cannot drift from the model. The scroll position is restored by hand,
 * because losing it on every tick would make the list unusable while the user reads it.
 */
function render() {
  if (role !== 'list' || !els.list) return;
  const keep = els.list.scrollTop;
  els.list.replaceChildren();

  if (todos.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有待办。下面加一条试试。';
    els.list.appendChild(empty);
  }

  for (const item of todos) {
    const row = document.createElement('div');
    row.className = item.done ? 'row done' : 'row';
    row.dataset.id = item.id;

    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.className = 'tick';
    tick.checked = item.done === true;
    tick.setAttribute('aria-label', item.done ? '标记为未完成' : '标记为完成');
    tick.addEventListener('change', () => toggle(item.id));

    const title = document.createElement('span');
    title.className = 'text';
    title.textContent = item.title;

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'kill';
    kill.textContent = '×';
    kill.title = '删除';
    kill.setAttribute('aria-label', '删除这条待办');
    kill.addEventListener('click', () => remove(item.id));

    row.append(tick, title, kill);
    els.list.appendChild(row);
  }

  const left = todos.filter((t) => !t.done).length;
  if (els.status) els.status.textContent = left === 0 ? '都做完了' : `${left} 件未完成`;
  els.list.scrollTop = keep;
}

function addTodo() {
  const text = (els.title?.value || '').trim();
  if (!text) return;
  if (role !== 'list' || !granted.has('storage')) return;
  if (els.title) els.title.value = '';
  todos.push({
    id: nextTodoId(),
    title: text,
    done: false,
    due: '',
    createdAt: new Date().toISOString(),
  });
  saveTodos();
  render();
}

function toggle(id) {
  if (role !== 'list' || !granted.has('storage')) return;
  const item = todos.find((t) => t.id === id);
  if (!item) return;
  item.done = !item.done;
  saveTodos();
  render();
}

function remove(id) {
  if (role !== 'list' || !granted.has('storage')) return;
  todos = todos.filter((t) => t.id !== id);
  saveTodos();
  render();
}

// --- the reminders (the headless frame) -------------------------------------

/** "HH:MM" as minutes since midnight, or NaN. */
function minutesOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/**
 * Says something, or does not.
 *
 * The rule is deliberately boring: at most one line per interval (plus jitter), only inside the
 * user's hours, only while something is undone. A reminder that fires on a timer nobody can predict
 * is a reminder people turn off, so the jitter is bounded by the user's own number and the interval
 * is measured from the last thing said - not from a fixed schedule.
 */
function tickReminders() {
  if (role !== 'background') return;
  if (!granted.has('pet.bubble')) return;
  if (settings.remindEnabled === false || settings.remindEnabled === 'false') return;
  // Nothing on this side writes on a timer, so this copy is at most one tick old (the only writers
  // are the surface and 1.3.0's call handlers) - and it is re-read here rather than pushed,
  // because this frame must keep working with no interface open at all.
  loadTodos();

  const open = todos.filter((t) => !t.done);
  if (open.length === 0) return;

  const now = new Date();
  const from = minutesOf(settings.remindFrom);
  const to = minutesOf(settings.remindTo);
  const at = now.getHours() * 60 + now.getMinutes();
  if (Number.isFinite(from) && Number.isFinite(to) && (at < from || at > to)) return;

  const intervalMin = Math.max(1, Number(settings.remindIntervalMin) || 30);
  const jitterMin = Math.max(0, Number(settings.remindJitterMin) || 0);
  const waitMs = (intervalMin + Math.random() * jitterMin) * 60000;
  if (Date.now() - lastSaid < waitMs) return;

  const max = Math.max(1, Math.min(5, Number(settings.remindMaxItems) || 3));
  const names = open.slice(0, max).map((t) => t.title);
  const more = open.length > names.length ? `，还有 ${open.length - names.length} 件` : '';
  // `todoAction` asks the host for the 「看看待办」 button. This line IS about the list, so it asks;
  // every other `bubble.say` caller (a chat reply, a video recommendation) leaves it off, and the
  // host then draws no button at all.
  request('bubble.say', {
    text: `别忘了：${names.join('、')}${more}`,
    todoAction: true,
  });


  lastSaid = Date.now();
  if (granted.has('storage')) {
    request('storage.set', { key: LAST_SAID_KEY, value: String(lastSaid) });
  }
}

// --- the bridge -------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

function onInit(data) {
  initialised = true;
  applyTheme(data.theme);
  granted = new Set(data.granted || []);

  const surface = data.surface || {};
  if (surface.kind === 'surface') role = 'list';
  else if (surface.slot === 'background') role = 'background';
  else role = 'list'; // a panel mount is treated as the list: same content, same controls

  els.root.className = role === 'background' ? 'bg' : 'view-list';
  els.root.dataset.surface = surface.kind || 'panel';

  const canWrite = granted.has('storage') && role === 'list';
  if (role === 'list') {
    els.title.disabled = !canWrite;
    els.add.disabled = !canWrite;
    els.title?.focus();
  } else {
    els.title.disabled = true;
    els.add.disabled = true;
    if (granted.has('storage')) pendingSaid = request('storage.get', { key: LAST_SAID_KEY });
  }

  // BOTH jobs need the list: the surface draws it, and the headless frame picks from it when it
  // decides whether there is anything worth reminding about.
  loadTodos();

  if (granted.has('plugin.config')) pendingConfig = request('config.get', {});

  // The loop runs in the headless frame only: the list frame is not always mounted, and two
  // frames both reminding would say everything twice.
  if (role === 'background') window.setInterval(tickReminders, 60000);
  if (role === 'list') startListPoll();
}

/**
 * Re-reads the list every two seconds while this document is a list.
 *
 * The surface used to be the ONLY writer, so a mount-time read was enough. It is not any more:
 * the control center mounts this same document (that is where the list lives now), and both can
 * be on screen at once - the pet's column and a real window. Two seconds is slow enough to be
 * free and fast enough that the second window is not visibly stale.
 */
function startListPoll() {
  if (!granted.has('storage')) return;
  // 30 秒兜底。主路径是 `storage.changed`（手册 §7.2）：另一个窗口存了列表，宿主会推过来。
  // 以前这里是 2 秒一次 `storage.get`——真机上那是这个插件最大的一笔调用量，而它等的事情
  // （用户在另一个窗口勾了一行）一天也就发生几次。
  window.setInterval(() => {
    if (pendingList || writes.size > 0) return;
    loadTodos();
  }, 30_000);
}

function onResponse(data) {
  if (data.id) writes.delete(data.id);
  // 等答复的那条路（requestAsync，只给 plugin.call 的写方法用）：交给等在它上面的那个 promise，
  // 下面那些分支都按"这条 id 我没见过"处理不了它。放在 `writes.delete` **之后**是有意的——
  // 写入的 id 同时在这两个集合里，先删才不会漏下一条永远不见的 set（那会让界面的轮询一直暂停）。
  const waiting = data.id ? awaited.get(data.id) : null;
  if (waiting) {
    awaited.delete(data.id);
    window.clearTimeout(waiting.timer);
    waiting.resolve(data);
    return;
  }
  if (data.id && data.id === pendingList) {
    pendingList = null;
    // `storage.get` answers with a STRING (the value is a file), so the JSON is parsed here -
    // `todos.list` used to answer with the array itself and the two must not be confused.
    const value = data.ok && data.result ? data.result.value : '';
    todos = parseTodos(value);
    render();
    // Publish after the first read as well as after every write: an installation that was migrated
    // by the host has data but no snapshot yet, and the pomodoro's picker reads the snapshot.
    if (role === 'list') publishList();
    return;
  }
  if (data.id && data.id === pendingSaid) {
    pendingSaid = null;
    const n = Number.parseInt(String((data.ok && data.result && data.result.value) || '0'), 10);
    if (Number.isFinite(n)) lastSaid = n;
    return;
  }
  if (data.id && data.id === pendingConfig) {
    pendingConfig = null;
    const values = data.ok && data.result && data.result.values;
    if (values && typeof values === 'object') settings = { ...settings, ...values };
    return;
  }
  if (data.ok) return;
  if (data.error && els.status) els.status.textContent = data.error;
}

/**
 * `storage.changed`（手册 §7.2）：同一份列表可能在**另一个窗口**里被改过。
 *
 * 这个插件的一份列表会同时出现在桌宠旁边的列、控制中心的插件页、以及常驻的提醒帧里——
 * 而两个宿主现在都会推这条事件（控制中心也看私有目录）。所以列表这一侧不需要轮询：事件到了
 * 就读一次，2 秒的慢拍（现为 30 秒）只负责"事件丢了"。
 *
 * 写入还在飞的时候不读：那时候读回来的还是写入前的那一份（见 startListPoll 的守卫）。
 */
function onEvent(data) {
  if (!data || data.name !== 'storage.changed') return;
  const key = String((data.payload && data.payload.key) || '');
  if (key !== TODOS_KEY) return;
  if (role !== 'list') return;
  if (pendingList || writes.size > 0) return;
  loadTodos();
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
    case 'event':
      onEvent(data);
      break;
    case 'call':
      void onCall(data);
      break;
    default:
      break;
  }
}

if (els.add) els.add.addEventListener('click', addTodo);
if (els.title) {
  els.title.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      addTodo();
    }
  });
}
window.addEventListener('message', onMessage);

// Handshake step one. The host answers with exactly one `init`.
postToHost({ v: 1, type: 'ready' });
