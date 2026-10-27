// The pomodoro plugin (2.0.1).
//
// It OWNS the timer now: the state machine is `machine.js` in this same directory, the state and the
// records are in this plugin's own storage, and nothing here talks to the host's timer. That is the
// whole point of stage 2 of openspec/changes/todo-pomodoro-as-plugins: the host keeps a window, a
// region and a set of capabilities; the pomodoro is a plugin like any other.
//
// What it deliberately still uses from the host:
//   - `plugin.share` the todo list, as a SNAPSHOT the todo plugin publishes (`todo-list`). The list
//                    became that plugin's when `todos.*` retired; a snapshot read is enough for a
//                    picker that is opened by hand, and being at most one edit behind is why the
//                    reader declares `shareRead` instead of the host forwarding a copy;
//   - `pet.bubble`   to say a phase ended while no interface was open;
//   - `events`       still declared (and no longer subscribed to anything): a plugin that declares
//                    `background` must hold one of `events`/`net.ws`/`net.fetch`, and this one has
//                    no background frame yet - see openspec/changes/pomodoro-headless-timer.
//
// THE TWO GATES live here now, and that is a DOWNGRADE the user accepted explicitly: the host used
// to refuse to let a break start while the summary was unwritten, and a plugin cannot refuse
// anything the host does. So the gate is this plugin's own prompt - shown, not enforced. A user who
// uninstalls it gets no gates at all, which is the price of "the timer is a plugin".

import * as machine from './machine.js';

// The todo plugin owns the list; this one reads the snapshot it publishes.
const TODO_OWNER = 'com.shixiansi.plugin-todo';
const TODO_LIST = 'todo-list';

const els = {
  root: document.getElementById('root') || document.body,
  phase: document.getElementById('phase'),
  status: document.getElementById('status'),
  countdown: document.getElementById('countdown'),
  task: document.getElementById('task'),
  todo: document.getElementById('todo'),
  start: document.getElementById('start'),
  pause: document.getElementById('pause'),
  resume: document.getElementById('resume'),
  stop: document.getElementById('stop'),
  ask: document.getElementById('ask'),
  askLabel: document.getElementById('ask-label'),
  askText: document.getElementById('ask-text'),
  askOk: document.getElementById('ask-ok'),
  askSkip: document.getElementById('ask-skip'),
};

const STATE_KEY = 'pomodoro-state-v2';
const RECORDS_KEY = 'pomodoro-records-v2';

let initialised = false;
let granted = new Set();
let cfg = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
  autoStartNextPhase: true,
};
let state = machine.emptyState();
let records = [];
let todos = [];
// The gate that is on screen: '' | 'summary' | 'plan'. At most one, because the machine only ever
// parks on one question.
let asking = '';
let pendingState = null;
let pendingRecords = null;
let pendingTodos = null;
let pendingConfig = null;
let pendingWrite = null;
let seq = 0;
let ticker = null;

function nextId() {
  seq += 1;
  return `p${seq}-${Date.now().toString(36)}`;
}

function postToHost(msg) {
  try {
    window.parent.postMessage(msg, '*');
  } catch {
    // The host tore the iframe down.
  }
}

function request(method, payload) {
  if (!initialised) return null;
  const id = nextId();
  postToHost({ v: 1, type: 'request', id, method, payload });
  return id;
}

// --- storage ----------------------------------------------------------------

function saveState() {
  if (!granted.has('storage')) return;
  pendingWrite = request('storage.set', { key: STATE_KEY, value: JSON.stringify(state) });
}

function saveRecords() {
  if (!granted.has('storage')) return;
  pendingWrite = request('storage.set', { key: RECORDS_KEY, value: JSON.stringify(records) });
}

// --- drawing ----------------------------------------------------------------

function paint() {
  const running = machine.isRunning(state);
  const paused = state.runState === machine.RUN_PAUSED || state.runState === machine.RUN_STOPPED;
  const hasPhase = state.phase !== machine.PHASE_IDLE;

  if (els.phase) els.phase.textContent = machine.phaseLabel(state.phase);
  if (els.status) {
    els.status.textContent = asking
      ? '等你回答'
      : running
        ? '进行中'
        : hasPhase
          ? '已暂停'
          : '待开始';
  }
  if (els.task) {
    els.task.textContent = state.currentTodoTitle ? `在做：${state.currentTodoTitle}` : '';
    els.task.hidden = !state.currentTodoTitle;
  }

  const idle = state.phase === machine.PHASE_IDLE;
  els.start.disabled = running;
  els.pause.disabled = !running;
  els.resume.disabled = running || !paused || idle;
  els.stop.disabled = !running;

  // The gate takes the whole footer: while a question is up, the controls are not the next thing to
  // press, and leaving them clickable would let the user start a second session under a question.
  if (els.ask) els.ask.hidden = !asking;
  for (const el of [els.todo, els.start, els.pause, els.resume, els.stop]) {
    if (el) el.disabled = el.disabled || !!asking;
  }

  paintCountdown();
}

/** The number on screen, derived from the absolute instant the state holds. */
function paintCountdown() {
  if (!els.countdown) return;
  els.countdown.textContent = machine.formatCountdown(machine.remainingMs(state, Date.now()));
}

function paintTodos() {
  if (!els.todo) return;
  const keep = els.todo.value;
  els.todo.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '（不指定）';
  els.todo.appendChild(none);
  for (const t of todos.filter((x) => !x.done)) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.title;
    els.todo.appendChild(opt);
  }
  if (keep) els.todo.value = keep;
}

// --- the timer --------------------------------------------------------------

/**
 * Applies one outcome from the machine: persists it, writes the record, and raises the gate.
 *
 * The gates are the caller's business, not the machine's - the machine only says "a phase ended and
 * here is the record". This function is where that becomes a question on screen, which is also why
 * it is the only place that decides WHEN the next phase is allowed to run.
 */
function applyOutcome(out) {
  if (!out || !out.state) return;
  state = out.state;

  if (out.record) {
    const record = { ...out.record, id: nextId(), summary: '' };
    records.push(record);
    state.pendingRecordId = record.id;
    saveRecords();
  }
  saveState();

  if (!out.endedPhase) {
    paint();
    return;
  }

  if (out.endedPhase === machine.PHASE_FOCUS) {
    // A finished focus always has a record (the machine guarantees it), and the rest is parked: the
    // break may not run until the summary is answered. That is the gate, in the plugin.
    asking = 'summary';
    if (els.askLabel) els.askLabel.textContent = '这一段专注写点什么？';
    if (els.askText) {
      els.askText.value = '';
      els.askText.placeholder = '（可以留空）';
    }
    paint();
    return;
  }

  // A break just ended: the next focus is the one worth planning. `autoStartNextPhase` is
  // deliberately NOT honoured for this transition - the plan question is what replaces it, and a
  // focus that started behind the question is a session nobody agreed to.
  asking = 'plan';
  if (els.askLabel) els.askLabel.textContent = '接下来专注哪一件？';
  if (els.askText) {
    els.askText.value = '';
    els.askText.placeholder = '（可以留空）';
  }
  paint();
}

/** One second of the machine. */
function tick() {
  if (!initialised) return;
  if (asking) return; // a parked phase must not advance while a question is up
  const out = machine.reconcile(state, cfg, Date.now());
  if (out.clockJump) {
    state = out.state;
    saveState();
    if (els.status) els.status.textContent = '时钟跳变，已重置';
    paint();
    return;
  }
  if (out.endedPhase) {
    applyOutcome(out);
    return;
  }
  paintCountdown();
}

/** Answers the gate on screen and lets the parked phase run. */
function answerGate(skip) {
  if (!asking) return;
  const text = (els.askText?.value || '').trim();
  const now = Date.now();

  if (asking === 'summary') {
    const id = state.pendingRecordId;
    const record = records.find((r) => r.id === id);
    if (record) record.summary = skip ? '' : text;
    state.pendingRecordId = '';
    saveRecords();
    // The break has been parked since the focus ended; now it may run.
    applyOutcome(machine.resume(state, cfg, now));
  } else {
    const todoId = els.todo?.value || '';
    const todo = todos.find((t) => t.id === todoId);
    applyOutcome(machine.startFocus(state, cfg, todoId, todo ? todo.title : '', now));
  }

  asking = '';
  paint();
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
  els.root.className = 'view-face';
  els.root.dataset.surface = surface.kind || 'panel';

  if (granted.has('storage')) {
    pendingState = request('storage.get', { key: STATE_KEY });
    pendingRecords = request('storage.get', { key: RECORDS_KEY });
  }
  if (granted.has('plugin.share')) pendingTodos = request('share.get', { owner: TODO_OWNER, name: TODO_LIST });
  if (granted.has('plugin.config')) pendingConfig = request('config.get', {});

  if (!ticker) ticker = window.setInterval(tick, 1000);
  paint();
}

function onResponse(data) {
  const id = data.id;
  if (id && id === pendingState) {
    pendingState = null;
    try {
      const raw = data.ok && data.result && data.result.value;
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') state = { ...machine.emptyState(), ...parsed };
    } catch {
      // A state this plugin cannot parse is treated as idle rather than fatal.
    }
    paint();
    return;
  }
  if (id && id === pendingRecords) {
    pendingRecords = null;
    try {
      const raw = data.ok && data.result && data.result.value;
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) records = parsed;
    } catch {
      records = [];
    }
    return;
  }
  if (id && id === pendingTodos) {
    pendingTodos = null;
    // `share.get` answers `{value, at, key}`, and the value is the todo plugin's JSON snapshot of
    // its list. "Nobody published yet" is an EMPTY value rather than an error, so an unreadable or
    // absent snapshot means "nothing to pick from" - the picker already allows starting unattached.
    const raw = data.ok && data.result ? data.result.value : '';
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      todos = Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.title === 'string') : [];
    } catch {
      todos = [];
    }
    paintTodos();
    return;
  }
  if (id && id === pendingConfig) {
    pendingConfig = null;
    const values = data.ok && data.result && data.result.values;
    if (values && typeof values === 'object') {
      cfg = {
        focusMinutes: Number(values.focusMinutes) || cfg.focusMinutes,
        shortBreakMinutes: Number(values.shortBreakMinutes) || cfg.shortBreakMinutes,
        longBreakMinutes: Number(values.longBreakMinutes) || cfg.longBreakMinutes,
        longBreakEvery: Number(values.longBreakEvery) || cfg.longBreakEvery,
        autoStartNextPhase: values.autoStartNextPhase !== false,
      };
    }
    return;
  }
  if (data.ok) return;
  if (data.error && els.status) els.status.textContent = data.error;
}

function onEvent() {
  // Nothing arrives here any more. The todo list used to be the host's, so a change to it arrived as
  // `todos.changed`; the list is another plugin's now and the host has no event for "that value
  // changed". Staleness is not a problem in practice: the surface frame is created when the surface
  // OPENS, so every open re-reads the snapshot in `onInit` - the list cannot change while the picker
  // is on screen, because changing it means opening the todo plugin's own surface.
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

if (els.start) {
  els.start.addEventListener('click', () => {
    const todoId = els.todo?.value || '';
    const todo = todos.find((t) => t.id === todoId);
    applyOutcome(machine.startFocus(state, cfg, todoId, todo ? todo.title : '', Date.now()));
  });
}
if (els.pause) els.pause.addEventListener('click', () => applyOutcome(machine.pause(state, Date.now())));
if (els.resume) els.resume.addEventListener('click', () => applyOutcome(machine.resume(state, cfg, Date.now())));
if (els.stop) els.stop.addEventListener('click', () => applyOutcome(machine.stop(state, Date.now())));
if (els.askOk) els.askOk.addEventListener('click', () => answerGate(false));
if (els.askSkip) els.askSkip.addEventListener('click', () => answerGate(true));

window.addEventListener('message', onMessage);

postToHost({ v: 1, type: 'ready' });
