// The voice plugin's front end (1.0.0).
//
// It is a plain module in a sandboxed iframe: its only channel to the outside
// world is `postMessage` to its parent, using the bridge protocol (ready / init /
// request / response / event). There is deliberately no fetch, no storage API and
// no file access of its own - every capability goes through the host program that
// mounted it.
//
// ONE document serves TWO appearances, and `applyView` is the single place that
// decides which one:
//
//   surface.slot === 'background'   the pet's headless frame. No interface: it
//                                   subscribes to the timer and reminder events
//                                   and plays a clip. THIS is what makes the
//                                   plugin work while no panel is open.
//   surface.slot === 'workshop'     the workshop, hosted by the plugin market
//                                   program in this plugin's settings area.
//
// The host program differs between the two (the pet mounts the headless frame,
// the market mounts the workshop), so the plugin must never assume which
// capabilities are available: it asks, and a refusal is a normal answer. For
// example `todos.list` exists in the pet and not in the market.

const els = {
  root: document.getElementById('root') || document.body,
  bg: document.getElementById('bg'),
  workshop: document.getElementById('workshop'),
  status: document.getElementById('status'),
  roles: document.getElementById('roles'),
  roleNote: document.getElementById('role-note'),
  reloadRoles: document.getElementById('reload-roles'),
  adoptAll: document.getElementById('adopt-all'),
  lines: document.getElementById('lines'),
  engineState: document.getElementById('engine-state'),
  engineHelp: document.getElementById('engine-help'),
  onMaster: document.getElementById('on-master'),
  onPomodoro: document.getElementById('on-pomodoro'),
  onReminder: document.getElementById('on-reminder'),
};

// The five lines, and what each one says.
//
// The TEXT lives here rather than in the host, which is the whole point of this
// plugin: the pet used to own these sentences in internal/voice/voice.go, and a
// plugin that could only play host-defined clips would not be a voice plugin - it
// would be a remote control for one. The built-in audio shipped in this package
// (see the manifest's `assets`) was rendered from exactly these sentences, so what
// the user hears by default matches what this table says.
const LINES = [
  { id: 'focus_end',        label: '番茄钟·专注结束', text: '专注时间结束了，起来活动一下吧。' },
  { id: 'break_end',        label: '番茄钟·休息结束', text: '休息结束了，我们继续吧。' },
  { id: 'reminder_due',     label: '待办提醒·有到期', text: '有些事情到期了，记得看一下。' },
  { id: 'reminder_overdue', label: '待办提醒·有逾期', text: '有事情已经逾期了，记得处理一下。' },
  { id: 'reminder_none',    label: '待办提醒·无待办', text: '现在没有待办，好好休息吧。' },
];

// Which line answers which event. The payloads carry FACTS (a phase, counts), and
// this is where they become a choice of sentence - the host never made this
// decision for the plugin, which is the separation the change was for.
function lineForPhase(phase) {
  return phase === 'focus' ? 'focus_end' : 'break_end';
}

function lineForReminder(payload) {
  const total = Number(payload && payload.total) || 0;
  const overdue = Number(payload && payload.overdue) || 0;
  const due = Number(payload && payload.due) || 0;
  if (total === 0) return 'reminder_none';
  if (overdue > 0) return 'reminder_overdue';
  return 'reminder_due';
}

const HISTORY_KEY = 'voice-settings';

let initialised = false;
const granted = new Set();
let view = 'workshop';
let seq = 0;

// Settings, in this plugin's own storage: the master switch, the two per-notice
// switches, which role is active, and which take each line uses.
//
// `takes` is the plugin's own inventory WITH metadata, and it is the reason the
// role list works offline: the host's audio.list knows only slot names and byte
// counts, so which character a clip belongs to is knowledge only this plugin has.
// Keeping it here is what lets "switch every line to 宵宫" be a purely local
// operation that needs no engine, no network and no regeneration.
let settings = {
  enabled: false,
  pomodoro: true,
  reminder: false,
  activeRole: '',
  // line id -> audio slot name. Absent or not-on-disk means "use the packaged clip".
  chosen: {},
  // line id -> [{ name, role, roleName, text, durationMs }]
  takes: {},
  // role id -> display name
  roleNames: {},
};

// What the host currently holds in this plugin's audio directory, by name.
let clips = [];

/**
 * True once the stored settings have been READ from the host.
 *
 * Everything that writes is gated on it, because writing before reading destroys what
 * was there: `settings` is the empty default until the reply lands, so an early save
 * replaces a real library with nothing. See saveSettings.
 */
let settingsLoaded = false;

// The names the five packaged clips are imported under. They are the built-in
// fallback: a character that has not rendered a line yet still speaks, in the
// voice the package shipped with, instead of going silent.
const BUILTIN_PREFIX = 'builtin-';
const IMPORTED_KEY = 'voice-imported';

// The packaged clips, keyed by line id. These paths are also in the manifest's
// `assets`, which is what allows audio.import to read them.
const PACKAGED = {
  focus_end: 'lines/focus_end.wav',
  break_end: 'lines/break_end.wav',
  reminder_due: 'lines/reminder_due.wav',
  reminder_overdue: 'lines/reminder_overdue.wav',
  reminder_none: 'lines/reminder_none.wav',
};

/**
 * Copies the packaged clips into the plugin's own audio directory, once.
 *
 * It has to happen because the player works on the plugin's PRIVATE directory, and
 * the package is read-only: audio.play takes a name, not a package path. Doing it
 * once and remembering it keeps a 569 KB copy per install rather than per launch,
 * and the marker means a user who deletes one of them does not get it silently
 * re-imported.
 *
 * The plugin COULD read its own package over HTTP (the asset route sets
 * Access-Control-Allow-Origin, so the opaque-origin frame may fetch it) and then
 * hand the bytes to audio.save - but that pushes the whole clip through the bridge
 * twice, as an ArrayBuffer and then as base64. audio.import has the host copy the
 * file directly, and the plugin only names it.
 */
function ensureBuiltins() {
  if (!granted.has('audio')) return;
  if (builtinsImported) return;
  // The stored marker is what makes this once-per-INSTALL rather than once-per-launch,
  // and both halves matter:
  //
  //   - 569 KB through the bridge on every start is work nobody asked for;
  //   - re-importing RESURRECTS A CLIP THE USER DELETED. Someone who removes a built-in
  //     line because they dislike it would find it back after every restart, with no
  //     way to make it stay gone.
  //
  // `builtinsImported` is the in-memory guard for the same session (the reply can
  // arrive twice if the workshop re-reads its state); this is the persistent one.
  if (settings.imported) {
    builtinsImported = true;
    return;
  }
  builtinsImported = true;
  for (const [lineID, from] of Object.entries(PACKAGED)) {
    request('audio.import', { name: `${BUILTIN_PREFIX}${lineID}`, from });
  }
  settings.imported = true;
  // Safe to save here and ONLY here: ensureBuiltins is called from the settings reply
  // handler, i.e. after the read this write depends on. Calling it earlier is what
  // wiped a migrated library once; see saveSettings.
  saveSettings();
}

let builtinsImported = false;

function nextId() {
  seq += 1;
  return `v${seq}-${Date.now().toString(36)}`;
}

/** A monotonically increasing suffix, so a re-render never overwrites a take. */
function nextAudioVersion() {
  audioVersion += 1;
  return audioVersion;
}

let audioVersion = 0;

function postToHost(msg) {
  try {
    window.parent.postMessage(msg, '*');
  } catch {
    // The host tore the frame down; nothing sensible to do.
  }
}

function setStatus(text) {
  if (els.status) els.status.textContent = text;
}

/**
 * Reports whether the synthesis engine is reachable.
 *
 * The plugin does NOT start it: a plugin has no way to launch a process, and adding
 * one would hand every installed plugin the ability to run code. So the workshop
 * says what it sees and the user starts the service themselves.
 *
 * The result is REMEMBERED in `engineUp`, because it is what lets 生成 refuse before
 * sending a request that cannot succeed. `null` means "not probed yet": unknown is not
 * the same as down, and blocking on unknown would make the button dead until a probe
 * happened to answer.
 */
function refreshEngineState() {
  if (!els.engineState) return;
  if (!granted.has('net.fetch')) {
    els.engineState.textContent = '没有联网权限，无法生成';
    engineUp = false;
    return;
  }
  const url = configuredValue('ttsBaseUrl');
  if (!url) {
    els.engineState.textContent = '没有配置语音服务地址';
    engineUp = false;
    return;
  }
  // The engine's health endpoint is the root; the reply's status is all that is
  // read, so a plain GET is enough.
  engineUp = null;
  els.engineState.textContent = '正在检查语音服务…';
  request('net.fetch', { url, method: 'GET' }, 'engine');
}

/**
 * Whether the engine answered its last probe.
 *
 * `null` until one has come back. Only a definite `false` blocks a render - see
 * generate.
 */
let engineUp = null;

/**
 * Shows or hides the command that starts the engine.
 *
 * Shown only when a probe has DEFINITELY failed: "unknown" must not print a command at
 * someone whose engine is running fine but slow to answer. The plugin cannot run this
 * itself - "launch a process" is not a capability any plugin gets - so the text is the
 * whole help.
 */
function renderEngineHelp() {
  if (!els.engineHelp) return;
  els.engineHelp.classList.toggle('hidden', engineUp !== false);
}

/** Chooses which appearance this frame draws. */
function applyView(surface) {
  const slot = surface && surface.slot ? surface.slot : '';
  view = slot === 'background' ? 'background' : 'workshop';
  els.root.className = view === 'background' ? 'view-background' : 'view-workshop';
  els.root.dataset.view = view;
  if (els.bg) els.bg.hidden = view !== 'background';
  if (els.workshop) els.workshop.hidden = view !== 'workshop';
}

// --- the background appearance ---------------------------------------------

/**
 * Plays one line, if the switches allow it.
 *
 * The precedence is: the master switch, then the per-notice switch, then the
 * audio. A missing clip is NOT an error - it is the normal state for a character
 * that has not rendered that sentence yet, and the whole reason the plugin falls
 * back to the packaged audio rather than going silent.
 */
function playLine(lineID, notice) {
  if (!settings.enabled) return;
  if (notice === 'pomodoro' && !settings.pomodoro) return;
  if (notice === 'reminder' && !settings.reminder) return;
  if (!granted.has('audio')) return;

  // The name comes from the SAME resolver the workshop's 试听 uses, so what the pet
  // says and what the user heard when they auditioned it cannot be two different
  // takes - which is exactly what two copies of this fallback would eventually
  // produce. See resolveClipFor: the packaged clip is the fallback whenever the
  // user's own render is absent OR no longer on disk.
  request('audio.play', { name: resolveClipFor(lineID) });
}

// --- the workshop appearance ------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The characters this plugin can speak as.
 *
 * They come from the plugin's OWN `roleNames`, which the migration fills from the
 * studio's library. Reading them from `settings` rather than keeping a separate list
 * is what makes the user's existing characters appear at all: the plugin has no way to
 * discover them on its own (the engine lists weights, not names, and the pet no longer
 * knows what a character is), so the library IS the list.
 *
 * Before this was wired up the left column could never render: the character list was
 * a module-level array that nothing ever filled, and the renderer was reachable only
 * from its own click handler, so "click a character to switch voice" was a feature
 * that existed only in the interface.
 */
function rolesFromSettings() {
  const named = settings.roleNames || {};
  return Object.keys(named)
    .sort()
    .map((id) => ({ id, name: named[id] || id }));
}

function renderSwitches() {
  if (!els.onMaster) return;
  const canChat = granted.has('audio');
  els.onMaster.checked = settings.enabled === true;
  els.onPomodoro.checked = settings.pomodoro === true;
  els.onReminder.checked = settings.reminder === true;
  els.onMaster.disabled = !canChat;
  els.onPomodoro.disabled = !canChat;
  els.onReminder.disabled = !canChat;
}

function saveSettings() {
  // NOTHING may be written before what is on disk has been READ.
  //
  // This guard is load-bearing and it was learned from a real data loss: the plugin
  // wrote its settings during the handshake - ensureBuiltins saved a flag - while the
  // `storage.get` reply was still in flight. `settings` was still the empty default at
  // that moment, so the write REPLACED the migrated library with
  // `{activeRole:"",chosen:{},takes:{},roleNames:{}}`. The audio survived and the
  // pointer to it did not, which is the worst possible shape: 12 clips on disk, the
  // pet speaking the packaged voice, and a `.migrated` marker promising the migration
  // had succeeded. The user's 宵宫 renders were still there and unreachable.
  //
  // A flag rather than a queue: a save that arrives before the read is a bug in the
  // caller's ORDERING, and silently deferring it would hide that. The correct sequence
  // is enforced where it belongs - reloadState issues the read, and the reply handler
  // is what starts anything that writes.
  if (!settingsLoaded) return;
  request('storage.set', { key: HISTORY_KEY, value: JSON.stringify(settings) });
}

/**
 * How many of a character's lines are actually rendered and on disk.
 *
 * A character with no takes for a line is the state the studio marked 待生成, and the
 * count is what makes the adoption button honest: switching to a character that has
 * recorded nothing would otherwise look like it worked and change no sound.
 */
function takesForRole(roleID) {
  let n = 0;
  for (const line of LINES) {
    const takes = (settings.takes || {})[line.id] || [];
    // The take must ALSO still be on disk, or adopting it would point every event at a
    // missing file - which plays nothing at all, silently.
    if (takes.some((t) => t.role === roleID && clips.some((c) => c.name === t.name))) n += 1;
  }
  return n;
}

function renderRoles() {
  if (!els.roles) return;
  els.roles.replaceChildren();
  const available = rolesFromSettings();
  if (available.length === 0) {
    els.roles.append(el('li', 'empty',
      granted.has('storage')
        ? '还没有角色。旧配音库会在桌宠下次启动时自动搬进来；也可以先在插件配置里填好三个路径再生成。'
        : '这个程序没有授予保存数据的权限，读不到角色。'));
  } else {
    for (const role of available) {
      const li = el('li', 'role');
      li.dataset.role = role.id;
      const count = takesForRole(role.id);
      li.append(el('span', 'role-name', role.name));
      // The count is shown for every character, including the active one: it is the
      // answer to "if I switch, will anything change?".
      li.append(el('span', 'role-count', `${count} / ${LINES.length}`));
      if (role.id === settings.activeRole) li.classList.add('active');
      li.addEventListener('click', () => {
        settings.activeRole = role.id;
        saveSettings();
        renderRoles();
        renderLines();
        setStatus(count > 0
          ? `已切到「${role.name}」，这一角色有 ${count} 条可播`
          : `已切到「${role.name}」，但它还没有录过任何句子`);
      });
      els.roles.append(li);
    }
  }
  renderAdoptAll();
}

/**
 * Wires the one-click "use this character for everything".
 *
 * It is a pure LOCAL operation and that is the point: adopting picks, for each line,
 * the take that belongs to the active character and is on disk. No engine, no network
 * and no regeneration - the renders already exist, and rebuilding them would cost
 * minutes of GPU time to arrive at the same audio.
 *
 * A line with no take for that character keeps whatever it had (usually the packaged
 * clip), which is the studio's "the character has not recorded this sentence stays
 * silent rather than falling back" rule expressed as "nothing else is changed".
 */
function renderAdoptAll() {
  if (!els.adoptAll) return;
  const available = rolesFromSettings();
  const canAdopt = granted.has('storage') && available.length > 0;
  els.adoptAll.disabled = !canAdopt;
  if (!canAdopt) return;
  // Bound once rather than per render: renderRoles runs on every click, and adding a
  // listener each time would make one click adopt N times.
  if (els.adoptAll.dataset.wired === '1') return;
  els.adoptAll.dataset.wired = '1';
  els.adoptAll.addEventListener('click', () => {
    const role = settings.activeRole;
    if (!role) {
      setStatus('先在上面点一个角色');
      return;
    }
    let adopted = 0;
    let missing = 0;
    for (const line of LINES) {
      const takes = (settings.takes || {})[line.id] || [];
      const usable = takes.find(
        (t) => t.role === role && clips.some((c) => c.name === t.name));
      if (usable) {
        settings.chosen[line.id] = usable.name;
        adopted += 1;
      } else {
        // Nothing recorded for this line by this character: leave it as it is rather
        // than pointing it at a file that does not exist.
        missing += 1;
      }
    }
    saveSettings();
    renderLines();
    setStatus(missing === 0
      ? `已把 ${adopted} 条全部换成该角色`
      : `已换 ${adopted} 条，还有 ${missing} 条该角色没录过（保持原样）`);
  });
}

/** Renders one row per line, with the takes this plugin holds for it. */
function renderLines() {
  if (!els.lines) return;
  els.lines.replaceChildren();
  for (const line of LINES) {
    const row = el('div', 'line');
    // The line id is on the element so an asynchronous reply can find its row
    // again. Without it, "the render for THIS line finished" would have to be
    // matched by position, which breaks the moment the list is re-rendered.
    row.dataset.line = line.id;
    const head = el('div', 'line-head');
    head.append(el('span', 'line-label', line.label));
    const chosen = settings.chosen[line.id];
    head.append(el('span', 'badge', chosen ? `当前：${chosen}` : '当前：内置'));
    row.append(head);
    row.append(el('p', 'line-text', line.text));

    const actions = el('div', 'line-actions');
    const audition = el('button', 'btn tiny', '试听');
    audition.addEventListener('click', () => {
      request('audio.play', { name: resolveClipFor(line.id) });
      setStatus(`试听「${line.label}」`);
    });
    actions.append(audition);

    const gen = el('button', 'btn tiny btn-generate', '生成');
    gen.addEventListener('click', () => generate(line, gen));
    actions.append(gen);

    if (chosen) {
      const clear = el('button', 'btn tiny', '改回内置');
      clear.addEventListener('click', () => {
        delete settings.chosen[line.id];
        saveSettings();
        renderLines();
      });
      actions.append(clear);
    }
    row.append(actions);
    els.lines.append(row);
  }
}

/**
 * Which clip name to play for a line.
 *
 * The user's own render wins when the host confirms it is on disk; otherwise the
 * packaged one. Checking against the inventory rather than trusting `settings` is
 * what makes a DELETED take fall back to the built-in voice instead of playing
 * nothing at all - the plugin's stored choice outlives the file.
 */
function resolveClipFor(lineID) {
  const chosen = settings.chosen[lineID];
  if (chosen && clips.some((c) => c.name === chosen)) return chosen;
  return `${BUILTIN_PREFIX}${lineID}`;
}

// --- talking to the engine ---------------------------------------------------

function configuredValue(key) {
  return (configValues && configValues[key]) || '';
}

// The plugin's declared settings, as the host returns them.
let configValues = {};

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
}

/**
 * Renders one line through the engine.
 *
 * The engine is NOT started by the plugin, and the three steps stay separate the
 * same way the studio's did: a render is stored and remembered as the chosen take,
 * but nothing about it is spoken until an event arrives. So a bad render costs
 * nothing but a click - the user auditions it, and switches back to the built-in
 * clip if they do not like it.
 *
 * THE WEIGHTS ARE SET FIRST, and that is what makes "switch character" actually change
 * the voice. The engine keeps ONE model loaded, so a render uses whatever was loaded
 * last; posting only to /tts would therefore synthesise with the PREVIOUS character and
 * the new one would never be heard. The old studio had the same three calls in the same
 * order. The reply comes back through the normal response path, tagged so the sequence
 * can continue (see onResponse).
 */
function generate(line, button) {
  if (!granted.has('net.fetch')) {
    setStatus('没有联网权限，无法生成');
    return;
  }
  if (!configuredValue('gptPath') || !configuredValue('sovitsPath') || !configuredValue('refPath')) {
    setStatus('先在插件配置里填好三个权重路径');
    return;
  }
  const base = configuredValue('ttsBaseUrl').replace(/\/+$/, '');
  if (!base) {
    setStatus('没有配置语音服务地址');
    return;
  }
  // A probe that DEFINITELY failed blocks the render, so the user gets the real answer
  // ("the service is not running, start it") instead of a request that is certain to
  // fail. `null` - not probed, or probed and not answered - deliberately does NOT
  // block: unknown is not down, and refusing on unknown would make the button dead
  // until a probe happened to complete.
  if (engineUp === false) {
    setStatus('语音服务未运行，请先自行启动');
    refreshEngineState();
    return;
  }
  button.disabled = true;
  setStatus(`正在切到该角色的权重…`);

  // Which line this render is for travels in a map keyed by request id, so it survives
  // the two weight calls in between. A reply that named no line would have to be
  // guessed at, and guessing here means overwriting the wrong take.
  const id = request('net.fetch', {
    url: `${base}/set_gpt_weights?weights_path=${encodeURIComponent(configuredValue('gptPath'))}`,
    method: 'GET',
  }, 'weights-gpt');
  if (id) generateLines.set(id, line.id);

  // The base is remembered for the rest of the sequence: the two follow-up calls and
  // the render itself need it, and re-deriving it from config each time would break if
  // the user edited the field mid-render.
  if (id) generateBase.set(id, base);
}

/** The engine base URL for an in-flight render, keyed by the request that started it. */
const generateBase = new Map();

/** Sends the second weight call, then the render itself. */
function continueGenerate(afterID, lineID) {
  const base = generateBase.get(afterID) || '';
  if (!base) return;
  const id = request('net.fetch', {
    url: `${base}/set_sovits_weights?weights_path=${encodeURIComponent(configuredValue('sovitsPath'))}`,
    method: 'GET',
  }, 'weights-sovits');
  if (id) {
    generateLines.set(id, lineID);
    generateBase.set(id, base);
  }
}

/** Sends the render request, with the weights now loaded. */
function finishGenerateRequest(afterID, lineID) {
  const base = generateBase.get(afterID) || '';
  generateBase.delete(afterID);
  if (!base) return;
  const line = LINES.find((l) => l.id === lineID);
  if (!line) return;
  setStatus(`正在生成「${line.label}」…`);
  // `encoding: "base64"` is REQUIRED here, not a preference: the reply is a WAV, and
  // the text form of a response body is lossy for anything that is not valid UTF-8
  // - every 0x80+ byte comes back as U+FFFD, so the file is the right size and plays
  // as noise.
  const id = request('net.fetch', {
    url: `${base}/tts`,
    method: 'POST',
    encoding: 'base64',
    body: JSON.stringify({
      text: line.text,
      text_lang: 'zh',
      ref_audio_path: configuredValue('refPath'),
      prompt_text: configuredValue('promptText'),
      prompt_lang: configuredValue('promptLang') || 'zh',
      speed_factor: Number(configuredValue('speed')) || 1,
      temperature: Number(configuredValue('temperature')) || 1,
      top_k: Number(configuredValue('topK')) || 15,
      top_p: Number(configuredValue('topP')) || 1,
      repetition_penalty: Number(configuredValue('repetitionPenalty')) || 1.35,
      seed: Number(configuredValue('seed')),
      streaming_mode: false,
    }),
  }, 'generate');
  if (id) generateLines.set(id, lineID);
}

// --- host messages ----------------------------------------------------------

/**
 * What each outstanding request was for.
 *
 * The host answers every request with the id the plugin chose, and WITHOUT this
 * map there is no way to tell one answer from another: a `storage.get` reply and a
 * `config.get` reply are both just `{ok, result}`, and treating a config reply as
 * settings (or the reverse) silently replaces good data with the wrong shape. So
 * every request is recorded by purpose, and the response is routed by looking it up.
 *
 * `null` means "no reply is expected to carry data" - a save, a play, a subscribe.
 */
const pending = new Map();

function request(method, payload, purpose) {
  if (!initialised) return null;
  const id = nextId();
  pending.set(id, purpose || null);
  postToHost({ v: 1, type: 'request', id, method, payload });
  return id;
}

/** The id of the most recent request made for a purpose, or null. */
function pendingFor(purpose) {
  for (const [id, p] of pending) {
    if (p === purpose) return id;
  }
  return null;
}

function onInit(data) {
  initialised = true;
  applyTheme(data.theme);
  granted.clear();
  for (const p of data.granted || []) granted.add(p);
  applyView(data.surface || {});
  setStatus('已就绪');

  // With no storage permission there is no read to wait for, so writing is "safe" in
  // the only sense that matters here - there is nothing on disk to destroy. The save
  // will simply be refused, and the plugin runs from memory for this session. Leaving
  // the flag false would instead mean the switches silently did nothing at all.
  if (!granted.has('storage')) settingsLoaded = true;

  if (view === 'background') {
    // The headless frame's entire job: subscribe, then answer events. It draws
    // nothing, so it never touches the UI elements below.
    if (granted.has('events')) {
      request('events.subscribe', { names: ['timer.phaseEnded', 'reminder.fired'] });
    }
    reloadState();
    return;
  }

  renderSwitches();
  // The five lines are drawn IMMEDIATELY, before any reply comes back, because they
  // are the plugin's OWN data: which sentences exist is not something the host knows
  // or needs to tell it. Waiting meant a workshop that showed an empty list until the
  // first response landed - and showed NOTHING AT ALL if every capability was refused,
  // which is exactly the state a plugin runs in while the user has not granted it
  // anything yet. The replies then fill in what only the host knows: which takes exist
  // and which one is chosen.
  renderLines();
  reloadState();
}

/**
 * Reads everything the plugin needs to draw itself: its settings, which clips it
 * holds, and its declared config values.
 *
 * Each is requested only when the permission for it was granted. A refused call
 * would otherwise be a normal answer that reads like an error, and the plugin
 * already knows from `init` what it may ask for.
 *
 * READS ONLY. Nothing here writes, and that is a rule rather than a style: `settings`
 * is the empty default until the storage reply lands, so a write issued from here would
 * overwrite the real library with nothing. Copying the packaged clips in - which does
 * write - therefore happens in the REPLY handler, once the read has happened. Getting
 * this wrong cost a real library once; see saveSettings.
 */
function reloadState() {
  if (granted.has('storage')) request('storage.get', { key: HISTORY_KEY }, 'settings');
  if (granted.has('audio')) request('audio.list', {}, 'clips');
  if (granted.has('plugin.config')) request('config.get', {}, 'config');
}

function onResponse(data) {
  const purpose = data.id != null ? pending.get(data.id) : null;
  if (data.id != null) pending.delete(data.id);

  if (!data.ok) {
    // A refusal is a NORMAL answer here, not an exception: this program does not
    // implement every capability the other one does, so a plugin that ran in the
    // pet and now runs in the market collects refusals for the methods that only
    // make sense there. Showing every one as an error would make a working plugin
    // look broken. It is reported in the status line only, where it explains
    // itself without interrupting.
    //
    // A failure in a RENDER SEQUENCE is the exception, and it has to be handled here
    // rather than left to the status line: the 生成 button was disabled when the
    // sequence started, and nothing else would ever re-enable it - so one failed
    // attempt would leave that line permanently unrenderable, which reads as a broken
    // plugin rather than as one failed request.
    if (typeof purpose === 'string' && (purpose === 'weights-gpt' || purpose === 'weights-sovits' || purpose === 'generate')) {
      const lineID = generateLines.get(data.id);
      generateLines.delete(data.id);
      generateBase.delete(data.id);
      if (view === 'workshop') setStatus(String(data.error || '生成失败'));
      finishGenerate(lineID);
      return;
    }
    if (view === 'workshop' && data.error) setStatus(String(data.error));
    // A failed ENGINE PROBE is the one refusal that changes a later decision: it is
    // what makes 生成 refuse instead of sending a request that cannot succeed. Only a
    // definite failure sets this - an unanswered probe leaves it `null`, which is
    // "unknown" and must not block anything.
    if (purpose === 'engine') {
      engineUp = false;
      if (els.engineState) els.engineState.textContent = '语音服务未运行，请先自行启动';
      renderEngineHelp();
    }
    return;
  }

  switch (purpose) {
    case 'settings': {
      const value = data.result && data.result.value;
      try {
        const parsed = JSON.parse(value || '{}');
        settings = { ...settings, ...parsed };
      } catch {
        // A settings blob this plugin cannot parse is treated as absent rather
        // than fatal: the next save overwrites it.
      }
      // The read has happened, so writing is safe from here on. This is set BEFORE
      // anything below can save, including ensureBuiltins.
      settingsLoaded = true;
      // The packaged clips are copied in only now: the import writes, and a write
      // before this point would have replaced the library with the empty default.
      if (granted.has('audio')) ensureBuiltins();
      if (view === 'workshop') {
        // The roles are re-rendered from the settings that just arrived: the character
        // list IS `roleNames`, so a workshop that rendered the lines but not the
        // characters would show the right sentences beside an empty column.
        renderSwitches();
        renderRoles();
        renderLines();
      }
      return;
    }
    case 'clips': {
      clips = Array.isArray(data.result) ? data.result : [];
      if (view === 'workshop') {
        // The inventory decides which takes are USABLE, so the per-role counts and the
        // adopt-all button both depend on it. Rendering only the lines would leave the
        // counts stale from the previous inventory.
        renderRoles();
        renderLines();
      }
      return;
    }
    case 'config': {
      configValues = (data.result && data.result.values) || {};
      if (view === 'workshop') {
        refreshEngineState();
        renderLines();
      }
      return;
    }
    case 'generate': {
      // The engine answered with audio, base64-encoded.
      //
      // The line this render belongs to comes from the request-id map, NOT from the
      // reply: the host's net.fetch does not know what a line is, so the reply
      // carries only a status and a body, and the plugin is the side that knows
      // which row asked.
      const lineID = generateLines.get(data.id);
      generateLines.delete(data.id);
      if (!lineID) return;
      const body = data.result && data.result.body;
      const status = data.result && data.result.status;
      if (status !== 200 || !body) {
        setStatus(`生成失败：语音服务返回 ${status}`);
        finishGenerate(lineID);
        return;
      }
      const name = `${slug(lineID)}-${nextAudioVersion()}`;
      // The take is remembered as PENDING until the host confirms it was written.
      // Adopting it here would point the pet at a clip that does not exist yet, and
      // a refused save (no audio permission, a full disk) would leave it pointing
      // at one that never will.
      savingLine.set(name, lineID);
      request('audio.save', { name, data: body }, 'saved-' + name);
      return;
    }
    case 'saved': {
      // The inventory changed, so ask for it again rather than guessing: the host
      // is the authority on which takes exist.
      if (granted.has('audio')) request('audio.list', {}, 'clips');
      setStatus('已保存这一版');
      return;
    }
    case 'engine': {
      // A reply of any status means something answered on that host and port, and
      // that is the whole question: whether the engine is running. The HTTP status
      // itself is not interesting - the engine answers 404 on its root - so the
      // distinction drawn is "answered at all" versus "the request failed", and the
      // latter arrives through the !ok branch above (where engineUp is set false).
      engineUp = true;
      if (els.engineState) els.engineState.textContent = '语音服务已就绪';
      renderEngineHelp();
      return;
    }
    case 'weights-gpt': {
      // The sequence is set_gpt_weights -> set_sovits_weights -> /tts, and it only
      // continues if each step answered. A model switch that silently half-applied
      // would render the new sentence in the OLD voice, which is the reported bug this
      // ordering exists to prevent.
      const lineID = generateLines.get(data.id);
      generateLines.delete(data.id);
      if (!lineID) return;
      continueGenerate(data.id, lineID);
      return;
    }
    case 'weights-sovits': {
      const lineID = generateLines.get(data.id);
      generateLines.delete(data.id);
      if (!lineID) return;
      finishGenerateRequest(data.id, lineID);
      return;
    }
    default: {
      // A save's own confirmation, tagged with the take it wrote.
      if (typeof purpose === 'string' && purpose.startsWith('saved-')) {
        const name = purpose.slice('saved-'.length);
        const lineID = savingLine.get(name);
        savingLine.delete(name);
        if (lineID) {
          settings.chosen[lineID] = name;
          saveSettings();
          if (view === 'workshop') renderLines();
        }
        finishGenerate(lineID);
      }
      // Anything else - a play, a subscribe - carries nothing back.
      return;
    }
  }
}

/** Which line each in-flight render belongs to, keyed by request id. */
const generateLines = new Map();

/** Which line each clip being written belongs to, keyed by its slot name. */
const savingLine = new Map();

/** Re-enables the 生成 button for one line, and reports that the render ended. */
function finishGenerate(lineID) {
  if (!els.lines) return;
  for (const row of els.lines.querySelectorAll('.line')) {
    if (row.dataset.line !== lineID) continue;
    const button = row.querySelector('.btn-generate');
    if (button) button.disabled = false;
  }
}

function onEvent(data) {
  if (view !== 'background') return;
  const payload = data.payload || {};
  switch (data.name) {
    case 'timer.phaseEnded':
      playLine(lineForPhase(payload.phase), 'pomodoro');
      break;
    case 'reminder.fired':
      playLine(lineForReminder(payload), 'reminder');
      break;
    default:
      // Unknown names are ignored on purpose: the host may add names before this
      // plugin knows about them.
      break;
  }
}

function onMessage(event) {
  // Only the host may drive this iframe.
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

/**
 * Applies the window's colour scheme.
 *
 * The market program owns the scheme and this document mirrors it: a sandboxed frame
 * cannot see the host's CSS, so the host hands it over - `?theme=` on the frame URL
 * (applied by the inline script in panel.html BEFORE the first paint), `init`, and a
 * `theme` message when the switch is flipped while the workshop is open.
 * `data-theme` on <html> is the whole interface to style.css.
 *
 * The pet mounts the same document with no scheme at all, which stays dark.
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

function wireWorkshop() {
  const save = () => {
    settings.enabled = els.onMaster.checked;
    settings.pomodoro = els.onPomodoro.checked;
    settings.reminder = els.onReminder.checked;
    saveSettings();
  };
  for (const el2 of [els.onMaster, els.onPomodoro, els.onReminder]) {
    if (el2) el2.addEventListener('change', save);
  }
  if (els.reloadRoles) {
    els.reloadRoles.addEventListener('click', () => {
      request('config.get', {});
    });
  }
}

window.addEventListener('message', onMessage);
wireWorkshop();

// Handshake step one. Until the host answers with exactly one `init`, every
// control stays disabled and no request is sent.
applyView({ slot: 'workshop' });
postToHost({ v: 1, type: 'ready' });
