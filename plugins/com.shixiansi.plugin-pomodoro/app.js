// The pomodoro plugin (2.1.0).
//
// It OWNS the timer: the state machine is `machine.js` in this same directory, the state and the
// records are in this plugin's own storage, and nothing here talks to the host's timer.
//
// 2.1.0: THE CLOCK MOVED INTO A HEADLESS FRAME. Until now the tick lived in the surface's document,
// which exists only while the floating surface is on screen - so a session that ended while it was
// closed was reconciled on the NEXT open, and the moment it ended was never announced to anyone. The
// visible consequence was the voice plugin's "番茄钟结束" line: it subscribes to `timer.phaseEnded`,
// the host's timer (its only emitter) retired in stage 2, and the plugin cannot raise a host event.
//
// So this document now has TWO appearances, and the split is the whole design:
//
//   surface.slot === 'background'   the TIMER. Reads storage, runs the tick, writes state and
//                                   records, answers the gates in data (not on screen), and
//                                   publishes `phase-ended` to `share` so neighbours can react.
//                                   It draws nothing and touches no DOM.
//   surface.kind === 'surface'      the VIEW. Reads the same storage once a second, draws it, and
//                                   sends COMMANDS (start/pause/resume/stop/answer) through
//                                   `plugin.share` back to the timer. It never writes state.
//
// THE ONE-WRITER RULE is load-bearing rather than tidy: both frames share `pomodoro-state-v2`, and
// two read-modify-write cycles over one key lose updates - the first writer's `completedCount`, or a
// freshly written record, would be silently overwritten by the other's older copy. So the view only
// ever reads, and every mutation happens in the frame that owns the clock.
//
// WHY THE COMMANDS GO THROUGH `share` AND NOT THE HOST: they are addressed to a SIBLING DOCUMENT of
// the same plugin, and the host has no concept of "my other frame". `plugin.share` is exactly that
// channel - a value the writer publishes under its own name - and it costs at most one tick (1s) of
// latency, which is the tick's own period.

import * as machine from './machine.js';

// The todo plugin owns the list; this one reads the snapshot it publishes.
const TODO_OWNER = 'com.shixiansi.plugin-todo';
const TODO_LIST = 'todo-list';

// The two values this plugin publishes, both under its own name (no declaration needed for your
// own keys):
//
//   phase-ended  the last ended phase and its REAL end moment, for the voice plugin to poll.
//                `at` is the phase's own deadline, not the moment this frame noticed it, so a
//                consumer can tell two endings apart and ignore one it already spoke for.
//   command      what the view asked the timer to do, cleared (emptied) as soon as it is applied.
const SHARE_PHASE_ENDED = 'phase-ended';
const SHARE_COMMAND = 'command';
// The host's event for your settings file changed (plugin manual, section 7).
const EVENT_CONFIG_CHANGED = 'config.changed';


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
  // The records view (this round) and the two pieces the control center's mount hides.
  compose: document.getElementById('compose'),
  elsewhere: document.getElementById('elsewhere'),
  records: document.getElementById('records'),
  recordsList: document.getElementById('records-list'),
  recordsEmpty: document.getElementById('records-empty'),
};

const STATE_KEY = 'pomodoro-state-v2';
const RECORDS_KEY = 'pomodoro-records-v2';

let initialised = false;
let granted = new Set();
// Which appearance this document is: 'timer' (headless) or 'view' (the floating surface).
//
// ONE document, TWO jobs - and the job decides everything below: who ticks, who writes, who draws.
// `role` is set from the handshake and never changes, because an iframe is one appearance for its
// whole life (the host rebuilds it if the plugin is updated, not if the surface re-opens).
let role = 'boot';
// True when this document is mounted by the CONTROL CENTER (surface.slot === 'workshop').
// It changes what is honest to show: no timer runs here, so no timer controls.
let workshop = false;
// What the host mounted us as (surface / panel). Only the surface has a declared rect that the
// host will re-crop on request - see fitToGate.
let mountKind = 'surface';
// Counts the view's one-second ticks so the records are re-read on a slower beat.
let recordsTick = 0;
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
// The gate: '' | 'summary' | 'plan'. At most one, because the machine only ever parks on one
// question. It is STATE, not a screen: the timer holds it in its own copy and publishes it as part
// of the state, and the view draws whatever the state says. That is what lets a gate survive the
// surface being closed - the question is still waiting when the user comes back.
// Mirrors state.asking; see syncGate. It exists so the tick's hot path does not re-derive it.
let asking = '';
let pendingState = null;
let pendingRecords = null;
let pendingTodos = null;
let pendingConfig = null;
let pendingWrite = null;
let pendingCommand = null;
// The last `phase-ended` this frame has published, so a refire cannot repeat it (see publishPhaseEnded).
let lastPublishedAt = 0;
let seq = 0;
let ticker = null;
// The settings poll (see onInit): the timer frame lives for the whole session, so the config has
// to be re-read or a change made in the control center never arrives.
let configSubscribed = null;
// Our own id (from init): config.changed is broadcast, so we filter on it.
let pluginId = '';

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
//
// The DRAWING half runs in the view and also in the timer, but for different reasons: the view
// paints what it read, and the timer paints nothing on screen (it has none) - it calls paint() only
// so the code that decides "what does the state look like right now" has one implementation rather
// than two. Both look at the same `state`, and neither draws into the other's document.

function paint() {
  if (role === 'timer') {
    // No DOM. The headless frame's `els` are all null, and touching them would throw.
    return;
  }
  const running = machine.isRunning(state);
  const paused = state.runState === machine.RUN_PAUSED || state.runState === machine.RUN_STOPPED;
  const hasPhase = state.phase !== machine.PHASE_IDLE;
  // The gate is READ from the state, not remembered here: the timer owns it, and the view is a
  // second document that can be closed and reopened while a question is still waiting.
  const gate = state.asking || '';
  fitToGate(!!gate);

  if (els.phase) els.phase.textContent = machine.phaseLabel(state.phase);
  if (els.status) {
    els.status.textContent = gate
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
  els.start.disabled = running || !!gate;
  els.pause.disabled = !running || !!gate;
  els.resume.disabled = running || !paused || idle || !!gate;
  els.stop.disabled = !running || !!gate;

  // The gate takes the whole footer: while a question is up, the controls are not the next thing to
  // press, and leaving them clickable would let the user start a second session under a question.
  if (els.ask) els.ask.hidden = !gate;
  for (const el of [els.todo, els.start, els.pause, els.resume, els.stop]) {
    if (el) el.disabled = el.disabled || !!gate;
  }

  paintAsk();
  paintCountdown();
}

/** Writes the gate's wording. Its own function because the TEXT differs from the visibility. */
function paintAsk() {
  if (role === 'timer') return;
  const gate = state.asking || '';
  fitToGate(!!gate);
  if (els.askLabel) {
    els.askLabel.textContent = gate === 'summary'
      ? '这一段专注写点什么？'
      : gate === 'plan'
        ? '接下来专注哪一件？'
        : '';
  }
  if (els.askText && els.askText.value === '' && gate) {
    els.askText.placeholder = '（可以留空）';
  }
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

// --- the records view ---------------------------------------------------------
//
// The sessions that happened, newest first. Until this round they were WRITTEN (by the timer)
// and read by nobody: the floating surface beside the pet is a countdown and one line of
// controls, so a list of sessions had nowhere to live. The control center's 插件 page is that
// place - it is a real window, and it already mounts this document.
//
// READ-ONLY on purpose. The timer is the only writer of `pomodoro-records-v2`, and a second
// writer over one storage key is the bug this document is arranged to avoid (see the header).

/** Renders up to 20 sessions from `records`. */
function paintRecords() {
  if (!els.records || !els.recordsList) return;
  const rows = records
    .filter((r) => r && typeof r.id === 'string' && Number.isFinite(Number(r.endedAt)))
    .slice()
    .sort((a, b) => Number(b.endedAt) - Number(a.endedAt))
    .slice(0, 20);

  els.recordsList.replaceChildren();
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'record';

    const when = document.createElement('span');
    when.className = 'record-when';
    when.textContent = formatWhen(Number(r.endedAt));
    li.appendChild(when);

    const what = document.createElement('span');
    what.className = 'record-what';
    const minutes = Number(r.focusMinutes) > 0 ? `${Number(r.focusMinutes)} 分钟` : '一段专注';
    what.textContent = r.todoTitle ? `${minutes} · ${r.todoTitle}` : minutes;
    li.appendChild(what);

    // The summary is what the user typed when asked. Absent is normal (the question can be
    // skipped), and an empty span would leave a gap in every row.
    if (typeof r.summary === 'string' && r.summary.trim() !== '') {
      const note = document.createElement('span');
      note.className = 'record-note';
      note.textContent = r.summary.trim();
      li.appendChild(note);
    }
    els.recordsList.appendChild(li);
  }
  els.recordsEmpty.hidden = rows.length > 0;
  els.records.hidden = false;
}

/** "10-28 14:32" - local clock, month and minute resolution. */
function formatWhen(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- the timer (the headless frame) -------------------------------------------

/**
 * Sets the parked-gate flag on the state AND on the module variable.
 *
 * One function because the two must never disagree: `state.asking` is what gets persisted and read
 * back (that is how a gate survives the surface being closed), and the module variable is what the
 * tick checks before advancing a phase. A gate that lived only in the variable would vanish on the
 * next launch; one that lived only in the state would be re-read after the phase had already moved.
 */
function syncGate(gate) {
  asking = gate;
  state.asking = gate;
}

/**
 * Applies one outcome from the machine: persists it, writes the record, and raises the gate.
 *
 * TIMER ONLY. The view never calls this and never writes state - two read-modify-write cycles over
 * one storage key would lose whichever update landed first, which for a finished session means a
 * record that was just written quietly disappears.
 *
 * The gates are the caller's business, not the machine's: the machine says "a phase ended and here
 * is the record", and this is where that becomes a parked phase. `asking` is part of the state that
 * gets persisted, so a gate outlives the surface being closed - the question is still waiting when
 * the user opens it again.
 */
function applyOutcome(out) {
  if (!out || !out.state) return;
  state = out.state;

  if (out.record) {
    // The record id is derived from the phase's END moment rather than from a counter: a session
    // that ends while this frame is being restarted, or a reconcile that runs twice over the same
    // deadline, then produces the SAME id - a duplicate that storage.set overwrites instead of two
    // entries for one session.
    const id = `rec-${out.record.endedAt}`;
    if (!records.some((r) => r.id === id)) {
      records.push({ ...out.record, id, summary: '' });
    }
    state.pendingRecordId = id;
    saveRecords();
  }

  if (!out.endedPhase) {
    saveState();
    paint();
    pushBadge();
    return;
  }

  // Publish the fact BEFORE the gate: the voice plugin's line is about the phase that just ended,
  // and it must not wait for a question the user has not answered.
  publishPhaseEnded(out.endedPhase, out.record ? out.record.endedAt : Date.now());

  if (out.endedPhase === machine.PHASE_FOCUS) {
    // A finished focus always has a record (the machine guarantees it), and the rest is parked: the
    // break may not run until the summary is answered. That is the gate, in the plugin.
    syncGate('summary');
  } else {
    // A break just ended: the next focus is the one worth planning. `autoStartNextPhase` is
    // deliberately NOT honoured for this transition - the plan question is what replaces it, and a
    // focus that started behind the question is a session nobody agreed to.
    syncGate('plan');
  }
  saveState();
  paint();
}

/**
 * Publishes "a phase ended" where a sibling plugin can read it.
 *
 * This is the emitter `timer.phaseEnded` never had. The host retired its timer in stage 2, and a
 * plugin cannot raise a host event, so the honest channel is the one built for plugin-to-plugin
 * facts: `share`. The voice plugin declares `shareRead` on this exact pair and polls it from its own
 * headless frame.
 *
 * `at` is the phase's own DEADLINE, not the moment this frame noticed it. That is what makes the
 * value a fact rather than an observation: a consumer that already spoke for this deadline can
 * ignore it, and one that wakes up two minutes late still knows when the phase really ended.
 *
 * The value is cleared to `''` when there is nothing new to say. That matters at startup: a timer
 * frame that restarts would otherwise re-publish the last ending it can still see in the state, and
 * the voice plugin would speak for a session that finished five minutes ago.
 */
function publishPhaseEnded(phase, at) {
  if (!granted.has('plugin.share')) return;
  lastPublishedAt = at;
  request('share.set', {
    name: SHARE_PHASE_ENDED,
    value: JSON.stringify({ phase: phase === machine.PHASE_FOCUS ? 'focus' : 'break', at }),
  });
}

/**
 * One second of the timer: collect any command the view left, then advance the machine.
 *
 * The command read comes FIRST and BEFORE the gate guard below, because `answer` is exactly the
 * command that arrives while a gate is up. Reading it after `if (asking) return` would make the
 * summary question unanswerable - the one state the whole two-frame design has to get right.
 *
 * There is no second timer for the command channel. A `setInterval(readCommand, 1000)` next to this
 * one was scheduled behind `if (!ticker)`, which this function had already set, so it never ran and
 * EVERY button press was silently dropped. One timer, one place to look.
 */
function tick() {
  if (!initialised || role !== 'timer') return;
  readCommand();
  if (asking) {
    // A parked phase must not ADVANCE while a question is up - but it still has time left, and the
    // card keeps showing it, so the head must too. Returning here without pushing is what made the
    // clock disappear exactly when a phase ended and the summary gate opened.
    pushBadge();
    return;
  }
  const out = machine.reconcile(state, cfg, Date.now());
  if (out.clockJump) {
    state = out.state;
    saveState();
    paint();
    pushBadge();
    return;
  }
  if (out.endedPhase) {
    applyOutcome(out);
    pushBadge();
    return;
  }
  paint();
  pushBadge();
}

/**
 * Answers the gate and lets the parked phase run. TIMER ONLY.
 *
 * `todoId` comes from the view's command rather than from a `<select>`, because the answer is typed
 * on one document and applied in another. With no id the session simply has no todo attached, which
 * is the same thing the picker's "（不指定）" meant.
 */
function answerGate(skip, text, todoId) {
  if (!asking) return;
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
    const todo = todos.find((t) => t.id === todoId);
    applyOutcome(machine.startFocus(state, cfg, todoId || '', todo ? todo.title : '', now));
  }

  syncGate('');
  saveState();
  paint();
}

// --- the commands (the shared channel) ---------------------------------------

/**
 * Applies one command the VIEW left for the timer.
 *
 * The view cannot call the machine: it holds no authority over the state and must not write it.
 * So it publishes the intent under this plugin's own `command` key, the timer picks it up on its
 * next storage read, and empties the key. One second of latency at worst, which is the tick.
 *
 * A malformed or stale command is ignored rather than fatal: the channel is a plain file, and a
 * half-written value must not take the timer down.
 */
function applyCommand(raw) {
  if (!raw) return;
  let cmd;
  try {
    cmd = JSON.parse(raw);
  } catch {
    return;
  }
  if (!cmd || typeof cmd.op !== 'string') return;

  const now = Date.now();
  switch (cmd.op) {
    case 'start': {
      if (asking) return;
      const todoId = typeof cmd.todoId === 'string' ? cmd.todoId : '';
      const todo = todos.find((t) => t.id === todoId);
      applyOutcome(machine.startFocus(state, cfg, todoId, todo ? todo.title : '', now));
      return;
    }
    case 'pause':
      if (asking) return;
      applyOutcome(machine.pause(state, now));
      return;
    case 'resume':
      if (asking) return;
      applyOutcome(machine.resume(state, cfg, now));
      return;
    case 'stop':
      if (asking) return;
      // 停止 ENDS the session; it is not "暂停 with a different word".
      //
      // `machine.stop` deliberately means "a pause the user asked for: recoverable" - it keeps the
      // banked remainder and `resume` picks it back up - and a test pins that meaning. But the
      // button next to 暂停 is 停止, and a 停止 that resumes into the same session is
      // indistinguishable from 暂停 on screen: the user reported exactly that. So the UI's 停止
      // abandons the phase instead (no record, back to 待开始), which is what the word means.
      applyOutcome(machine.reset(state));
      return;
    case 'skip':
      if (asking) return;
      applyOutcome(machine.skipPhase(state, cfg, now));
      return;
    case 'answer':
      answerGate(cmd.skip === true, typeof cmd.text === 'string' ? cmd.text : '',
        typeof cmd.todoId === 'string' ? cmd.todoId : '');
      return;
    default:
      return;
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
  pluginId = data.pluginId || '';

  const surface = data.surface || {};
  // The two appearances. `slot === 'background'` is the host's headless frame: it must be checked
  // FIRST, because that frame's `kind` is also 'panel' (it is a document with no rectangles), so a
  // test on `kind` alone would run the timer in the view's body and the view in the timer's.
  role = surface.slot === 'background' ? 'timer' : 'view';

  // `workshop` is the CONTROL CENTER's mount (its 插件 page). The timer runs in the pet's
  // headless frame; this window has none, so every button in the footer would send a command
  // nobody reads. They are hidden rather than left dead, and the line above the records says
  // where the timer actually is.
  workshop = role === 'view' && surface.slot === 'workshop';
  mountKind = surface.kind || 'surface';

  if (role === 'view') {
    els.root.className = workshop ? 'view-workshop' : 'view-face';
    els.root.dataset.surface = surface.kind || 'surface';
    if (workshop) {
      if (els.compose) els.compose.hidden = true;
      if (els.elsewhere) els.elsewhere.hidden = false;
      if (els.records) els.records.hidden = false;
    }
  } else {
    els.root.className = 'view-background';
    els.root.dataset.surface = 'background';
  }

  if (granted.has('storage')) {
    pendingState = request('storage.get', { key: STATE_KEY });
    // BOTH roles read the records now: the timer writes them, and the view (the pet's surface
    // or the control center's page) is where they are read back.
    pendingRecords = request('storage.get', { key: RECORDS_KEY });
  }
  if (granted.has('plugin.share')) {
    // Both roles read the todo snapshot: the timer needs it to record WHAT a session was about, and
    // the view needs it to offer the picker.
    pendingTodos = request('share.get', { owner: TODO_OWNER, name: TODO_LIST });
    if (role === 'timer') {
      // And the timer is the one that watches for a command from the view. Reading it here rather
      // than on the first tick saves a second of latency on the very first press.
      pendingCommand = request('share.get', { name: SHARE_COMMAND });
    }
  }
  if (granted.has('plugin.config')) pendingConfig = request('config.get', {});

  if (role === 'timer') {
    if (!ticker) ticker = window.setInterval(tick, 1000);
    // The settings are read AGAIN, slowly, for the whole life of this frame - and that is a
    // bug fix rather than caution: the timer frame is mounted once and stays mounted, so a
    // `config.get` on mount alone means the settings a user changes in the control center
    // never reach the machine. Reported as "设置了 5 分钟，停止后下一个番茄钟还是 25 分钟":
    // the config was read at 25 and the frame never asked again.
    //
    // Three seconds, not thirty: the user changes the number and presses 开始 right after, and
    // a stale config then is indistinguishable from "the setting does nothing". It is a single
    // `config.get` (DEBUG in the host log, and repeats are folded), so the cost is nil.
    // Settings are re-read when the HOST SAYS they changed (`config.changed`), not on a timer:
    // this frame lives for the whole session, so a read at mount alone meant a setting changed
    // in the control center never reached the machine. The 3-second poll that fixed that was a
    // per-plugin timer doing the host's job - the host now watches config.json and broadcasts.
    if (granted.has('events') && !configSubscribed) {
      configSubscribed = request('events.subscribe', { names: [EVENT_CONFIG_CHANGED] });
    }
  } else {
    // The view does not tick the machine - it re-reads the state the timer wrote. Its countdown is
    // local (derived from the absolute `endsAt`), so a slow read cannot make the number drift.
    if (!ticker) ticker = window.setInterval(refreshView, 1000);
  }
  paint();
  paintRecords();
}

// --- the line on the pet itself ----------------------------------------------

/**
 * Draws the countdown on the pet's own box (host capability `pet.badge`), when the user turned it
 * on in the settings (`showCountdown`).
 *
 * TIMER ONLY: the workshop's frames have no pet under them, and a second writer would fight this
 * one for the same line.
 *
 * Sent only when the VISIBLE text changes. A push every tick would be one IPC round trip per second
 * for a string that is identical 59 times out of 60 - and the host folds repeats, so the log would
 * report fewer calls than really happened.
 *
 * `pet.badge` borrows the `pet.surface` grant (see the host's app_pet_badge.go): same authority,
 * and updating does not ask the user to authorise a 14th permission.
 */
let badgeText = null;
function pushBadge() {
  if (!initialised || role !== 'timer' || !granted.has('pet.surface')) return;
  // `settingOn`, not `=== true`: the value arrives as the STRING `"true"` (see machine.js), so the
  // strict comparison was false for ever and the badge was pushed as an empty string.
  //
  // The countdown is shown for the whole life of a PHASE, not only while it is running: paused and
  // "parked waiting for your answer" both still have time left, and the card beside the pet keeps
  // showing it. Requiring `isRunning` cleared the head at exactly the moment the user looks at the
  // card and sees 05:00 - reported as 「没有显示时间」 with a screenshot of a parked break.
  // `remainingMs` is the machine's own answer for all three states (running uses `endsAt`, the
  // halted ones use `remainingOnHalt`).
  const idle = state.phase === machine.PHASE_IDLE;
  const left = idle ? 0 : machine.remainingMs(state, Date.now());
  const wanted = machine.settingOn(cfg.showCountdown) && left > 0 ? machine.formatCountdown(left) : '';
  if (wanted === badgeText) return;
  badgeText = wanted;
  request('pet.badge', { text: wanted });
}

/**
 * Asks the host for a taller block while the summary gate is up.
 *
 * WHY: the card's rectangle is DECLARED in the manifest (380x260) and the iframe is exactly that
 * tall, so anything beyond it is cut off - reported as 「界面被截断了」 with the 取消/跳过 row sliced
 * in half. The gate adds a question, a textarea and two buttons (about 170px), which cannot fit.
 *
 * `surface.blocks` is the host's mechanism for exactly this: it re-crops the window to the new
 * height. Only the surface mount has block geometry - the panel/workshop mounts are full-page and
 * asking there would be refused ("surface is not open").
 *
 * Empty `sizes` restores the declared height, so the card shrinks back when the gate closes.
 */
const GATE_BLOCK_H = 430;
let askedGateH = null;
function fitToGate(open) {
  if (role !== 'view' || mountKind !== 'surface') return;
  const want = open ? GATE_BLOCK_H : 0;
  if (want === askedGateH) return;
  askedGateH = want;
  request('surface.blocks', want ? { sizes: { 0: want } } : { sizes: {} });
}
/** Re-reads the declared settings (timer role). See onInit for why this exists. */
function refreshConfig() {
  if (!initialised || role !== 'timer' || pendingConfig) return;
  if (!granted.has('plugin.config')) return;
  pendingConfig = request('config.get', {});
}
/** The view's one-second read: state from storage, then draw.
 *
 *  The records are re-read on a slower beat (every 5th tick): they change only when a session
 *  ends, and polling a list of sessions once a second would be five times the traffic for a
 *  change the user cannot perceive.
 */
function refreshView() {
  if (!initialised || role !== 'view' || pendingState) return;
  pendingState = request('storage.get', { key: STATE_KEY });
  pendingCommand = null;
  paintCountdown();
  recordsTick += 1;
  if (recordsTick >= 5) {
    recordsTick = 0;
    if (!pendingRecords && granted.has('storage')) {
      pendingRecords = request('storage.get', { key: RECORDS_KEY });
    }
  }
}

/** The timer's command read: pick up whatever the view left, then clear it. */
function readCommand() {
  if (!initialised || role !== 'timer' || pendingCommand) return;
  pendingCommand = request('share.get', { name: SHARE_COMMAND });
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
    // The gate lives in the state, so this is where the view learns a question is waiting. It also
    // has to clear its own buffer: a gate the timer has already moved past must not keep a stale
    // sentence in the textarea.
    syncGate(state.asking || '');
    paint();
    return;
  }
  if (id && id === pendingCommand) {
    pendingCommand = null;
    const raw = data.ok && data.result ? data.result.value : '';
    // Applying the command is the timer's job; emptying the key afterwards is what makes it a
    // one-shot. Without the clear the same command would be applied on every tick.
    if (raw) {
      applyCommand(raw);
      request('share.set', { name: SHARE_COMMAND, value: '' });
    }
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
    paintRecords();
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
      // Every declared key has to be copied here, and booleans have to go through `settingOn`:
      // this object is REBUILT, so a key that is forgotten is silently undefined for ever - which
      // is exactly how 2.3.0 lost `showCountdown` (the badge pushed "" and nothing was drawn, while
      // the log happily said `pet.badge ok（payload 11 B → 11 B）`). And `values.x !== false` was
      // true for the string "false", so 自动开始 could not be turned off.
      cfg = {
        focusMinutes: Number(values.focusMinutes) || cfg.focusMinutes,
        shortBreakMinutes: Number(values.shortBreakMinutes) || cfg.shortBreakMinutes,
        longBreakMinutes: Number(values.longBreakMinutes) || cfg.longBreakMinutes,
        longBreakEvery: Number(values.longBreakEvery) || cfg.longBreakEvery,
        autoStartNextPhase: values.autoStartNextPhase === undefined
          ? cfg.autoStartNextPhase
          : machine.settingOn(values.autoStartNextPhase),
        showCountdown: machine.settingOn(values.showCountdown),
      };
    }
    return;
  }
  if (data.ok) return;
  if (data.error && els.status) els.status.textContent = data.error;
}

function onEvent(data) {
  if (!data || data.name !== EVENT_CONFIG_CHANGED) return;
  if (data.payload && data.payload.pluginId === pluginId) refreshConfig();
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

// --- the view's controls -----------------------------------------------------
//
// Every one of these sends a COMMAND rather than touching the machine. The view has no authority
// over the state: it is a second document, and two writers over one storage key lose updates. The
// cost is up to one tick of latency, which is invisible next to a 25-minute session - and the
// alternative (the view also calling machine.* and storage.set) is the bug this design exists to
// prevent.

/** Leaves an instruction for the timer, replacing whatever the previous one was. */
function command(op, extra) {
  if (role !== 'view') return;
  if (!granted.has('plugin.share')) {
    if (els.status) els.status.textContent = '缺少「与其它插件交换消息」权限';
    return;
  }
  request('share.set', { name: SHARE_COMMAND, value: JSON.stringify({ op, ...extra }) });
  // Draw the optimistic side of it at once: the countdown should not sit still for a second after
  // the user pressed a button. The next read corrects it if the timer disagreed (which it does when
  // a gate is up, and the state is then the authority).
  if (op === 'start') state = machine.startFocus(state, cfg, extra?.todoId || '', '', Date.now());
  else if (op === 'pause') state = machine.pause(state, Date.now());
  else if (op === 'resume') state = machine.resume(state, cfg, Date.now());
  else if (op === 'stop') state = machine.reset(state);
  paint();
}

if (els.start) {
  els.start.addEventListener('click', () => command('start', { todoId: els.todo?.value || '' }));
}
if (els.pause) els.pause.addEventListener('click', () => command('pause'));
if (els.resume) els.resume.addEventListener('click', () => command('resume'));
if (els.stop) els.stop.addEventListener('click', () => command('stop'));
if (els.askOk) {
  els.askOk.addEventListener('click', () =>
    command('answer', { text: (els.askText?.value || '').trim(), todoId: els.todo?.value || '' }));
}
if (els.askSkip) {
  els.askSkip.addEventListener('click', () =>
    command('answer', { skip: true, todoId: els.todo?.value || '' }));
}

window.addEventListener('message', onMessage);

postToHost({ v: 1, type: 'ready' });
