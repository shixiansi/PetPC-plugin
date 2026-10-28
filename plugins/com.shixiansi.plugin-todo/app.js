// The todo plugin (1.1.0).
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
// One rule follows from owning the data, and it is load-bearing: the SURFACE frame is the only
// writer. The headless frame re-reads `storage` before every reminder tick and never writes - two
// writers to one key would be a read-modify-write race over the whole list.

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
 * only writer, so the headless frame's copy is at most one tick (60s) old, and a reminder goes out
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
  // The surface frame is the only writer, so this copy can be one tick old - and it is re-read
  // here rather than pushed, because this frame must keep working with no interface open at all.
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
  window.setInterval(() => {
    if (pendingList || writes.size > 0) return;
    loadTodos();
  }, 2000);
}

function onResponse(data) {
  if (data.id) writes.delete(data.id);
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

function onEvent() {
  // Nothing to do. `todos.changed` was the host's "the list is not what you last read" signal, and
  // it was how the two frames of this plugin stayed in step while the list lived in the host's
  // store. The list is this plugin's now: the surface is the only writer, and the headless frame
  // re-reads storage on every reminder tick (once a minute, against a 30-minute interval).
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
