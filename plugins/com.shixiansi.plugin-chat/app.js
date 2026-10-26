// The conversation plugin's front end (1.3.0).
//
// It is a plain module loaded in a sandboxed iframe: it can address exactly one
// thing in the outside world, its parent, and only with the message types of
// the bridge protocol (ready / init / request / response / event). There is
// deliberately no fetch, no storage API and no file access - every capability
// goes through the host, which is also where the model key lives.
//
// ONE document serves THREE appearances, and `applySurface` is the single place
// that decides which one:
//
//   surface.kind === 'panel'    the conversation slot (message list + composer)
//   surface.kind === 'surface'  a floating block, by surface.rectIndex:
//                                 0  the reply strip ABOVE the pet (.view-card)
//                                 1  the input pill  just above the pet, with a tail
//                                    pointing down at it (.view-bar)
//
// The frame's geometry is NOT decided here: the host cropped the window to the
// rectangle it declared, so this file only fills the box it was given.

const els = {
  // The document's own <body> is the root appearance in a real frame; the
  // lookup is a NamedElement fallback so the same file also works in a harness
  // that mounts only the body's markup.
  root: document.getElementById('root') || document.body,
  reply: document.getElementById('reply'),
  prompt: document.getElementById('prompt'),
  status: document.getElementById('status'),
  send: document.getElementById('send'),
  stop: document.getElementById('stop'),
  bubble: document.getElementById('bubble'),
  surface: document.getElementById('surface'),
};

// Permission names, spelled once. A typo here would silently disable a control
// the user did grant.
const PERM_CHAT = 'llm.chat';
const PERM_BUBBLE = 'pet.bubble';
const PERM_SURFACE = 'pet.surface';

// The two appearances a floating block can take, in the order the manifest
// declares them: the reply card above the pet, then the input bar below it.
const SHAPE_CARD = 'view-card';
const SHAPE_BAR = 'view-bar';

// The storage key the transcript lives under. The host's storage.set/get take
// a key, not a path, so the plugin names its own file and the host keeps it in
// the plugin's private directory.
const HISTORY_KEY = 'llm-history';

// The tools this plugin lets the model call.
//
// A NAME, not a schema: the host owns what each tool does and what it may touch, so
// this list can only select from what the user has already allowed. A tool whose
// permission was not granted is dropped by the host and never reaches the model, so
// asking for one it cannot have is silent by design.
//
// `todo_list` is not optional. The host's world snapshot carries titles and due dates
// but NO ids, and every tool that acts on an existing todo needs one.
//
// `memory_*` is here rather than as a separate feature because it is the same
// mechanism: the only way the model can know something nobody said in THIS
// conversation. Its own descriptions say when to use it - which is also why this
// plugin still does not send a `system` prompt: sending one would make the host drop
// its world snapshot (see sendPrompt).
const TOOLS = [
  'todo_list', 'todo_add', 'todo_complete', 'pomodoro_start', 'pet_say',
  'memory_read', 'memory_append',
];

// What the pet is doing while a tool runs, keyed by the tool's name.
//
// The host sends the NAME and whether it worked - never the arguments, which can hold
// the user's todo text and would need todos.read to be worth showing.
const TOOL_STATUS = {
  todo_list: '正在看你的待办',
  todo_add: '正在记下这条待办',
  todo_complete: '正在划掉这条待办',
  pomodoro_start: '正在开番茄钟',
  pet_say: '正在说',
  memory_read: '正在回忆',
  memory_append: '正在记住这件事',
};

let initialised = false;
const granted = new Set();

// What the host told us about this frame in `init`.
let surfaceKind = 'panel';
let surfaceRectIndex = 0;

// The reply currently being streamed. `node` is the single text node that the
// whole answer is appended into - it must outlive every delta, because
// rebuilding it per frame would discard and re-layout the text on each chunk.
let current = null;
// The request id this frame is DONE with - finished, failed or stopped. A late
// frame carrying it must not start a new holder; see watchReply.
let endedRequestId = null;
// The text of the last finished reply, used as the bubble's line.
let lastReplyText = '';
// Whether this plugin believes its floating surface is on screen, so the
// button can toggle it rather than only ever ask for it.
let surfaceShown = false;
// The transcript, in the plugin's own private storage.
let history = [];
let seq = 0;

/** A message id unique within this plugin instance. */
function nextId() {
  seq += 1;
  return `p${seq}-${Date.now().toString(36)}`;
}

/** The one channel to the host. Nothing happens before `init` arrives. */
function postToHost(msg) {
  try {
    window.parent.postMessage(msg, '*');
  } catch {
    // The host tore the iframe down; there is nothing sensible to do.
  }
}

/**
 * Sends a host capability request.
 *
 * Refuses before the handshake completes: the granted set is unknown until
 * `init`, and guessing it would both spam the host and let the UI imply
 * permissions the user may not have given.
 */
function request(method, payload) {
  if (!initialised) return null;
  const id = nextId();
  postToHost({ v: 1, type: 'request', id, method, payload });
  return id;
}

/**
 * Appends a rendered line to the message list and scrolls it into view.
 *
 * Nothing is appended in the input bar: its message list is hidden, so a line
 * added there would be a node nobody can ever see. The bar reports failures
 * through the pet's speech bubble instead - see onError.
 */
function appendLine(kind, text) {
  if (surfaceKind === 'surface' && surfaceRectIndex !== 0) return null;
  const line = document.createElement('div');
  line.className = `msg ${kind}`;
  line.appendChild(document.createTextNode(text || ''));
  els.reply.appendChild(line);
  scrollToEnd();
  return line;
}

function scrollToEnd() {
  els.reply.scrollTop = els.reply.scrollHeight;
}

/**
 * True for the floating reply card: the block above the pet.
 *
 * It is the ONE appearance that is not a transcript view. The panel is the
 * record (every turn, scrollable); the card is the current answer, so it shows
 * the latest reply and nothing else - no history of what was sent, no question
 * line. `renderHistory`, `beginReply` and `sendPrompt` all branch on this, so
 * "which of the two things is this document drawing" has exactly one answer.
 */
function isReplyCard() {
  return surfaceKind === 'surface' && surfaceRectIndex === 0;
}

/**
 * True for the panel: the transcript view.
 *
 * Only this appearance shows the record - the questions the user sent as well as
 * the answers. The input bar is a composer with its list hidden, so appending a
 * line there would build nodes nobody ever sees.
 */
function isPanel() {
  return surfaceKind !== 'surface';
}

function setStatus(text) {
  els.status.textContent = text;
}

/**
 * Applies the granted set to the controls.
 *
 * Missing permissions are stated rather than hidden: a greyed-out control with
 * the reason visible is how the user learns that the plugin wants more than
 * they allowed.
 */
function applyGrants() {
  const canChat = granted.has(PERM_CHAT);
  const canBubble = granted.has(PERM_BUBBLE);
  const canSurface = granted.has(PERM_SURFACE);

  els.prompt.disabled = !canChat;
  els.send.disabled = !canChat;
  els.bubble.disabled = !canBubble;
  els.surface.disabled = !canSurface;
  els.stop.disabled = !canChat;

  if (!canChat) {
    setStatus('未获授权：llm.chat');
  } else {
    setStatus('已就绪');
  }
}

/**
 * Chooses which of the three appearances this frame draws.
 *
 * The root class is the switch, and it is set on BOTH the <body> and the
 * document root so a stylesheet can key off it without depending on which
 * element it inherited from. `data-surface` carries the kind itself, which is
 * what keeps the two floating shapes distinguishable in a DOM dump.
 *
 * An index beyond the two declared blocks falls back to the input bar rather
 * than to a shape that no longer exists: a plugin that declared more rectangles
 * than this file knows about would otherwise draw a third, unstyled appearance.
 */
function applySurface(surface) {
  const kind = surface && surface.kind ? surface.kind : 'panel';
  surfaceKind = kind;
  let shape = 'view-panel';

  if (kind === 'surface') {
    surfaceRectIndex = Number(surface.rectIndex) || 0;
    shape = surfaceRectIndex === 0 ? SHAPE_CARD : SHAPE_BAR;
  } else {
    surfaceRectIndex = 0;
  }

  els.root.className = shape;
  els.root.dataset.surface = kind;
  els.root.dataset.shape = shape;
  document.documentElement.dataset.surface = kind;

  // Where the tail points. NOT 50%: the host clamps every rectangle into the window, and the
  // pet sits flush against the window's right edge, so a block wider than the pet is shifted
  // left of the pet's centre. `rect.tailX` is that centre measured from this rectangle's left
  // edge, computed by the host where both rectangles are known.
  //
  // Missing (an older host, or a harness that sends no rect) falls back to centred, which is
  // the right answer for a block that was never clamped.
  const tailX = surface && surface.rect ? Number(surface.rect.tailX) : NaN;
  if (Number.isFinite(tailX)) {
    els.root.style.setProperty('--tail-x', tailX + 'px');
  } else {
    els.root.style.removeProperty('--tail-x');
  }

  // Each floating block is one piece of the same document: the card carries the
  // latest reply, the input bar carries only the composer. The other piece is
  // hidden rather than removed, so switching blocks never has to rebuild the
  // markup.
  //
  // The message list is shown in the PANEL and in the reply CARD, and hidden only
  // in the input bar - which has no list at all. Writing this as "hidden unless
  // the shape is the card" instead would hide the transcript in the panel, i.e.
  // the 对话 tab would render every message into an invisible box.
  els.reply.hidden = shape === SHAPE_BAR;
  if (shape === SHAPE_CARD) {
    renderHistory();
  }
  if (shape === SHAPE_BAR && els.prompt) {
    els.prompt.focus();
  }
}

/**
 * Renders the stored transcript into the message list.
 *
 * The two views read the SAME `history` array and draw different amounts of it:
 *
 *   panel / view-panel   every turn, oldest first - this is the record
 *   card  / view-card    only the LAST assistant reply - the current answer
 *
 * The card's slice is taken by scanning BACKWARDS for the last assistant entry
 * rather than by taking `history[history.length - 1]`. That matters after a
 * question is asked but before its answer arrives: the newest entry is then the
 * user's, and showing it would put the question back on the card the moment the
 * frame re-initialises. The card's job is the answer, so it keeps showing the
 * previous one until a new one exists.
 */
function renderHistory() {
  const lines = Array.isArray(history) ? history : [];
  els.reply.replaceChildren();

  if (isReplyCard()) {
    let last = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const item = lines[i];
      if (item && typeof item.text === 'string' && item.role !== 'user') {
        last = item;
        break;
      }
    }
    if (last) appendLine('assistant', last.text);
    return;
  }

  for (const item of lines) {
    if (!item || typeof item.text !== 'string') continue;
    appendLine(item.role === 'user' ? 'user' : 'assistant', item.text);
    if (item.role !== 'user') lastReplyText = item.text;
  }
}

/** Persists the transcript to the plugin's own storage. */
function saveHistory() {
  if (!granted.has('storage')) return;
  request('storage.set', { key: HISTORY_KEY, value: JSON.stringify(history) });
}

/** Replaces the transcript with a new turn pair. */
function remember(role, text) {
  history.push({ role, text });
  saveHistory();
}

/** Handles the host's single init frame, which is what unlocks the UI. */
function onInit(data) {
  initialised = true;
  applyTheme(data.theme);
  granted.clear();
  for (const p of data.granted || []) granted.add(p);
  applySurface(data.surface || {});
  applyGrants();
  if (granted.has('storage')) loadHistory();
  loadSettings();
}

/**
 * Reads the plugin's own declared settings.
 *
 * Only `llmHistoryTurns` is used from them, and it is used HERE rather than read by
 * the host: how much of the transcript to replay is a conversation-panel decision,
 * while the endpoint, the model and the credential belong to the host's llm.chat
 * path. A settings read that fails leaves the default in place.
 */
let settings = {};
let pendingConfig = null;

function loadSettings() {
  if (!granted.has('plugin.config')) return;
  pendingConfig = request('config.get', {});
}

// The request id whose response carries the stored transcript, so its response
// can be told apart from any other reply.
let pendingHistory = null;

/** Reads the transcript out of the plugin's own storage. */
function loadHistory() {
  const id = request('storage.get', { key: HISTORY_KEY });
  if (id) pendingHistory = id;
}

/** Renders a host response to a request we sent. */
function onResponse(data) {
  if (data.id && data.id === pendingHistory) {
    pendingHistory = null;
    const value = data.ok ? (data.result && data.result.value) : '';
    try {
      const parsed = JSON.parse(value || '[]');
      if (Array.isArray(parsed)) {
        history = parsed;
        if (surfaceKind !== 'surface' || surfaceRectIndex === 0) renderHistory();
      }
    } catch {
      // A transcript the plugin itself cannot parse is treated as empty rather
      // than fatal: the next turn overwrites it anyway.
    }
    return;
  }
  if (data.id && data.id === pendingConfig) {
    pendingConfig = null;
    const values = data.ok ? (data.result && data.result.values) : null;
    if (values && typeof values === 'object') settings = values;
    return;
  }
  if (data.ok) return;
  if (data.error) appendLine('system', data.error);
}

/**
 * Starts a streamed reply holder and returns it.
 *
 * `owner` says whether THIS frame is the one that asked the host for the reply.
 * Exactly one frame is: the one whose composer the user typed into. Every other
 * frame showing the same plugin receives the same `llm.*` events - the host
 * routes them to every interface of the plugin - so without this flag each frame
 * would `remember` the same answer and the transcript would gain one copy per
 * visible block.
 *
 * The reply card CLEARS first: it shows one answer at a time, so the previous
 * one has to give way to the live text rather than sit above it.
 */
function beginReply(requestId, owner) {
  if (isReplyCard()) els.reply.replaceChildren();

  const line = document.createElement('div');
  line.className = 'msg assistant streaming';
  const node = document.createTextNode('');
  line.appendChild(node);
  els.reply.appendChild(line);
  scrollToEnd();

  current = { requestId, node, line, text: '', owner: owner === true };
  return current;
}

/**
 * Makes sure a holder exists for a reply this frame is only WATCHING.
 *
 * The reply card above the pet never sends the request itself - the user types
 * into the input bar below the pet, or into the panel - so it has no holder when
 * the first delta arrives. Without this it would drop every chunk and stay empty
 * until the answer was already on disk, which is the opposite of a live reply.
 * The holder is display-only: `owner` stays false, so the frame that really
 * asked the question remains the only writer.
 *
 * A reply this frame has already FINISHED or ABANDONED is refused rather than
 * adopted again. `onDelta` used to drop a chunk whenever there was no holder,
 * which is how "stop" worked; adopting unconditionally would let one late frame
 * from a stopped reply rebuild the line the user just dismissed.
 */
function watchReply(requestId) {
  if (current) return current;
  if (requestId && requestId === endedRequestId) return null;
  return beginReply(requestId, false);
}

/**
 * Finalises the reply in flight and returns its text.
 *
 * The request id is remembered as ENDED, which is what stops a frame that
 * arrives late - a trailing delta after `stop`, a duplicate `done` - from
 * building a fresh holder for a reply this frame has already closed.
 */
function endReply() {
  if (!current) return '';
  current.line.classList.remove('streaming');
  endedRequestId = current.requestId || endedRequestId;
  const text = current.node.data;
  current = null;
  return text;
}

/** The accumulated text of the reply in flight, or ''. */
function pendingText() {
  return current ? current.node.data : '';
}

/**
 * Appends one streamed chunk.
 *
 * A chunk for a superseded request is dropped, never appended: with two
 * overlapping replies it would otherwise interleave into one paragraph.
 */
function onDelta(payload) {
  const requestId = payload && payload.requestId;
  const text = payload && payload.text;
  if (!text) return;
  if (!current && !watchReply(requestId)) return;
  if (requestId && current.requestId && requestId !== current.requestId) return;

  current.node.data += text;
  current.text = current.node.data;
  scrollToEnd();
}

/**
 * Ends the reply with the AUTHORITATIVE full text.
 *
 * The done frame carries the whole answer, so when it disagrees with what the
 * deltas accumulated - a chunk dropped in flight, a retry that re-sent the
 * tail - the displayed text is REPLACED rather than appended to. Appending
 * would leave the duplicated fragment the frame exists to repair.
 *
 * Only the OWNING frame writes the transcript. Every frame of the plugin sees
 * this event, so a frame that merely watched the reply must not `remember` it -
 * that is what would store one copy of the answer per visible block.
 */
function onDone(payload) {
  const requestId = payload && payload.requestId;
  if (!current && !watchReply(requestId)) return;
  if (requestId && current.requestId && requestId !== current.requestId) return;

  const owner = current.owner;
  const shown = current.node.data;
  const full = payload && typeof payload.text === 'string' ? payload.text : '';
  if (full && full !== shown) {
    current.node.data = full;
    current.text = full;
  }
  const text = endReply();
  if (!owner) return;
  lastReplyText = text;
  if (text) remember('assistant', text);
}

/**
 * Shows a failure the user must see.
 *
 * The panel and the reply card both have a visible message list, so the line
 * goes there - on the card it REPLACES the answer slot, which is right: the card
 * shows the current turn, and the current turn failed.
 *
 * The input bar has no visible list at all, so a line appended there would be
 * invisible. It hands the text to the pet's speech bubble instead, which is the
 * only surface that frame can actually draw.
 */
function reportProblem(text) {
  if (surfaceKind === 'surface' && surfaceRectIndex !== 0) {
    request('bubble.say', { text });
    return;
  }
  appendLine('system', text);
}

/** Ends the reply with a visible reason. */
function onError(payload) {
  const requestId = payload && payload.requestId;
  if (current && requestId && current.requestId && requestId !== current.requestId) return;
  endReply();
  reportProblem((payload && payload.message) || '对话失败');
}

/**
 * Shows what the pet is doing while the model runs a tool.
 *
 * Without this the UI sits on "正在回复…" for the whole loop and then jumps to the
 * answer, which reads as a stall rather than as work. With tools the answer can be
 * four rounds away.
 *
 * A FAILED tool is reported as a status line, not through reportProblem: the model
 * receives the failure too and goes on to answer, so a red "对话失败" would be
 * describing a conversation that is still happening.
 */
function onTool(payload) {
  const requestId = payload && payload.requestId;
  if (current && requestId && current.requestId && requestId !== current.requestId) return;
  const label = TOOL_STATUS[payload.name] || payload.name || '工具';
  setStatus(payload.ok === false ? label + '时出错了' : label + '…');
}

function onEvent(data) {
  const payload = data.payload || {};
  switch (data.name) {
    case 'llm.delta':
      onDelta(payload);
      break;
    case 'llm.done':
      onDone(payload);
      break;
    case 'llm.error':
      onError(payload);
      break;
    case 'llm.tool':
      onTool(payload);
      break;
    default:
      // Unknown event names are ignored on purpose: the host may add names
      // before this plugin knows about them.
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
 * The market program owns the scheme; this document mirrors it, because a sandboxed
 * frame cannot see the host's CSS. `data-theme` on <html> is the whole interface to
 * style.css, which holds both palettes. The value arrives three ways: `?theme=` on the
 * frame URL (applied by the inline script in panel.html BEFORE the first paint, so
 * there is no flash), `init`, and a `theme` message when the user flips the switch
 * while this frame is running.
 *
 * The pet mounts the same document with no scheme at all, which stays dark.
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

/**
 * Sends what is in the composer.
 *
 * The question line is drawn only where a transcript is being shown. The reply
 * card above the pet is the ANSWER view - it deliberately does not echo the
 * question - so this frame records the turn but adds no line for it.
 */
function sendPrompt() {
  const text = els.prompt.value.trim();
  if (!text) return;
  if (!granted.has(PERM_CHAT)) return;

  if (isPanel()) appendLine('user', text);
  remember('user', text);
  els.prompt.value = '';
  lastReplyText = '';

  const requestId = nextId();
  endedRequestId = null;
  beginReply(requestId, true);
  setStatus('正在回复…');
  // The replayed turns go with the request so the model can answer a follow-up
  // ("那明天呢") without the user repeating themselves. The host clamps the list
  // (roles, count, total length) and, because `system` is NOT sent here, keeps
  // assembling the pet's world snapshot as before.
  //
  // `tools` asks for the list above. The host runs whatever the model calls - up to
  // four rounds - and streams only the final answer, so the transcript this plugin
  // keeps stays plain text.
  request('llm.chat', { text, requestId, history: replayTurns(), tools: TOOLS });
}

/**
 * The turns to replay, oldest first, without the question just asked.
 *
 * `history` already ends with the new user message (sendPrompt remembered it a
 * line above), so it is dropped here: the host appends the new text itself, and
 * sending it twice would read to the model as a repeated question.
 */
function replayTurns() {
  const turns = history
    .slice(0, Math.max(0, history.length - 1))
    .slice(-historyTurns())
    .map((turn) => ({ role: turn.role, text: turn.text }));
  return turns;
}

/** How many turns of context the user asked for, from the plugin's own settings. */
function historyTurns() {
  const n = Number.parseInt(String(settings.llmHistoryTurns ?? '12'), 10);
  if (!Number.isFinite(n)) return 12;
  return Math.min(40, Math.max(0, n));
}

/**
 * Abandons the reply in flight.
 *
 * The holder is closed, which marks its request id as ended so the deltas still
 * in flight - and any frame of this plugin that was only watching - do not
 * rebuild it.
 */
function stopReply() {
  if (!current) return;
  endReply();
  setStatus('已停止');
}

function sayInBubble() {
  const line = (lastReplyText || '').split('\n')[0].trim();
  request('bubble.say', { text: line || '你好，我是对话插件。' });
}

/**
 * Asks the host to show or hide the floating surface.
 *
 * The plugin never places its own blocks: each one is a window region the host
 * cropped, so this only says whether the surface should be on screen. A plugin
 * whose surface permission was not granted cannot turn it on at all.
 */
function toggleSurface() {
  if (!granted.has(PERM_SURFACE)) return;
  if (surfaceShown) {
    request('surface.hide', {});
    surfaceShown = false;
  } else {
    request('surface.show', {});
    surfaceShown = true;
  }
}

if (els.send) els.send.addEventListener('click', sendPrompt);
if (els.stop) els.stop.addEventListener('click', stopReply);
if (els.bubble) els.bubble.addEventListener('click', sayInBubble);
if (els.surface) els.surface.addEventListener('click', toggleSurface);
if (els.prompt) {
  els.prompt.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendPrompt();
    }
  });
}
window.addEventListener('message', onMessage);

// Handshake step one. The host answers with exactly one `init`, and until it
// lands every control stays disabled.
applySurface({ kind: 'panel' });
applyGrants();
postToHost({ v: 1, type: 'ready' });
