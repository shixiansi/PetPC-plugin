// The conversation plugin's front end (1.6.8).
//
// It is a plain module loaded in a sandboxed iframe: it can address exactly one
// thing in the outside world, its parent, and only with the message types of the
// bridge protocol (ready / init / request / response / event). There is
// deliberately no fetch, no storage API and no file access - every capability
// goes through the host, which is also where the model key lives.
//
// ONE document, FOUR appearances, and each one is a FIXED JOB:
//
//   surface.kind === 'panel'     the conversation slot (transcript + composer)
//   surface.kind === 'surface'   one floating block, by surface.rectIndex:
//                                  0  the QUESTION box  (the last thing you said)
//                                  1  the ANSWER box    (current/last reply, with a tail)
//                                  2  the INPUT pill    (the composer, under the pet)
//
// The job is decided ONCE, from the declaration index, and never changes. That is
// the difference from 1.5.x, where one box was sometimes the question, sometimes
// the answer and sometimes the composer: with a fixed job, "which appearance am I"
// stops being a runtime question that can be answered wrong (it was, twice - see
// the git history for `rectIndex` and `visibleComposer`), and "the question becomes
// the answer" stops being a thing that has to happen at all.
//
// The frame's geometry is NOT decided here: the host cropped the window to the
// rectangle it declared, so this file only fills the box it was given. Nothing in
// this file asks the host to make a box taller - the three boxes around the pet add
// up to 156 of the ~160px available above it (see style.css), so growth is not a
// request the host could honour.

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

/* The build this document came from, shown in the input placeholder.
 *
 * A plugin frame is reloaded only when its version changes AND the surface is re-opened, so
 * "no visible change" has two very different causes: the code did not run, or it ran and did
 * nothing. Every check this session had to be re-derived from screenshots because there was no
 * way to see which build was on screen - this makes that a glance. Keep it in step with
 * manifest.json's version. */
const BUILD = '1.7.2';

/** The four jobs a document can have. `role` is decided by `init` and never changes. */
const ROLE_PANEL = 'panel';
const ROLE_QUESTION = 'question';
const ROLE_ANSWER = 'answer';
const ROLE_INPUT = 'input';

const SHAPE = {
  [ROLE_PANEL]: 'view-panel',
  [ROLE_QUESTION]: 'view-question',
  [ROLE_ANSWER]: 'view-answer',
  [ROLE_INPUT]: 'view-input',
};

let role = ROLE_PANEL;
let initialised = false;
const granted = new Set();

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
// 1.7.0: `todo_list` / `todo_add` / `todo_complete` are GONE, and with them the
// `todos.*` permissions. The list became the todo plugin's when `todos.*` retired
// (openspec/changes/todo-pomodoro-as-plugins), so the host has no todo method left to
// expose as a tool - and giving this plugin `shareRead` access to the other plugin's
// snapshot would have let the model READ the list while being unable to write it, which
// is the worst of both worlds. So the model chats; the list is edited where it lives.
//
// `memory_*` is here rather than as a separate feature because it is the same
// mechanism: the only way the model can know something nobody said in THIS
// conversation. Its own descriptions say when to use it - which is also why this
// plugin still does not send a `system` prompt: sending one would make the host drop
// its world snapshot (see sendPrompt).
const TOOLS = [
  'pet_say',
  'memory_read', 'memory_append',
];

// What the pet is doing while a tool runs, keyed by the tool's name.
//
// The host sends the NAME and whether it worked - never the arguments, which can hold
// the user's own text.
//
// Only the panel has a status line; the floating boxes hide the header. That is
// deliberate: the question box changing to the question you just asked IS the
// feedback that the surface took your message, and the answer starts arriving in the
// box above the pet a moment later.
const TOOL_STATUS = {
  pet_say: '正在说',
  memory_read: '正在回忆',
  memory_append: '正在记住这件事',
};

// --- per-frame state --------------------------------------------------------

// The request THIS frame sent. `null` when this frame did not send one.
//
// It replaces the old `owner` flag on a display holder, and it exists for one
// reason: `llm.*` events are delivered to EVERY interface of the plugin, so
// "should I write this answer to the transcript?" can only be answered by the frame
// that asked. With three floating boxes plus the panel, writing in the wrong frame
// means one stored copy of the answer per visible box.
//
// The frame that sends is not always the frame that displays: the input pill sends
// and draws nothing, while the answer box draws and never sends.
let ownRequestId = null;

// The exchange this frame is currently watching, and whether the QUESTION box has
// already read the transcript for it. Reset when a delta arrives for a new request.
let exchangeId = null;
let questionSynced = false;

// Whether an exchange is in flight, as far as THIS frame knows. It goes true when a new
// request's first event arrives (or when this frame sends), and false when the reply ends.
let asking = false;

// Whether the answer box has something to show. Sticky: once an exchange has produced an
// answer (or an error) the box keeps it, so the idle surface shows the last thing the pet
// said instead of an empty bubble.
let hasAnswer = false;

// A finished request's id. A delta carrying it is late and is dropped - that is what
// makes `stop` stay stopped.
let endedRequestId = null;

// True while a reply this frame sent is still in flight.
let busy = false;

// The thread the panel sends into the model: how many turns to replay.
let settings = {};
let pendingConfig = null;

// The transcript, in the plugin's own private storage.
let history = [];
// The text of the last finished reply, used as the bubble's line.
let lastReplyText = '';
// Whether this plugin believes its floating surface is on screen, so the button can
// toggle it rather than only ever ask for it.
let surfaceShown = false;
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

// --- drawing ---------------------------------------------------------------

/**
 * Appends one rendered line to the message list.
 *
 * The list is the panel's transcript and the single line of the question / answer
 * boxes; which slice goes in it is decided by the caller (`renderHistory`), so this
 * stays one code path for all three.
 */
function appendLine(kind, text) {
  const line = document.createElement('div');
  line.className = `msg ${kind}`;
  line.appendChild(document.createTextNode(text || ''));
  els.reply.appendChild(line);
  return line;
}

function scrollToEnd() {
  els.reply.scrollTop = els.reply.scrollHeight;
}

/** The last entry of one role, or null. Scanned backwards; the array is oldest-first. */
function lastEntry(wantRole) {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!item || typeof item.text !== 'string') continue;
    const itemRole = item.role === 'user' ? 'user' : 'assistant';
    if (itemRole === wantRole) return item;
  }
  return null;
}

/**
 * Renders the stored transcript into the message list, as much of it as this job shows.
 *
 *   panel      every turn, oldest first - this is the record
 *   question   ONLY the last user entry - it is the question of this exchange
 *   answer     ONLY the last assistant entry - it is the answer of this exchange
 *   input      nothing; its list is hidden and a line drawn there would be invisible
 *
 * The two one-line boxes take their slice by scanning BACKWARDS for their own role
 * rather than by taking the last array item. That matters while a question is in
 * flight: the newest entry is then the user's, and the ANSWER box must keep showing
 * the previous answer instead of putting the question up as if it were one.
 */
function renderHistory() {
  if (role === ROLE_INPUT) return;

  if (role === ROLE_PANEL) {
    els.reply.replaceChildren();
    for (const item of history) {
      if (!item || typeof item.text !== 'string') continue;
      appendLine(item.role === 'user' ? 'user' : 'assistant', item.text);
      if (item.role !== 'user') lastReplyText = item.text;
    }
    scrollToEnd();
    return;
  }

  // A transcript read must never overwrite text that is being streamed right now: the
  // read is a round trip, so it can land several deltas late.
  if (hasLiveHolder()) return;

  if (role === ROLE_QUESTION) {
    // The question box only has a job while its exchange runs (see hiddenSet): at open time
    // it is hidden, and hiding it is the host's job. Rendering into a hidden box would be
    // wasted work, and after `done` it would leave the last question behind for the next
    // exchange to flash up before its own text arrives.
    if (!asking) {
      els.reply.replaceChildren();
      return;
    }
    els.reply.replaceChildren();
    const asked = lastEntry('user');
    if (asked) appendLine('user', asked.text);
    return;
  }

  els.reply.replaceChildren();
  const item = lastEntry('assistant');
  if (item) appendLine('assistant', item.text);
}

// --- the streaming holder ---------------------------------------------------

// The line this frame is streaming into, or null. Only the panel and the answer box
// ever hold one: the question box never streams, and the input pill draws nothing.
//
// `text` is the full text received so far; `node` is what is on screen. They differ
// in the answer box, where a typewriter reveals the text progressively.
let current = null;

// True while `current` describes an exchange that has not finished. A holder whose
// request already ended is kept around (its node is still on screen) but must not
// absorb a delta.
function hasLiveHolder() {
  return !!current && current.requestId !== endedRequestId;
}

/** Stops the typewriter and forgets its queue. */
function stopTyper() {
  if (typer) window.clearInterval(typer);
  typer = null;
}

/**
 * The answer as it should be SHOWN: without leading/trailing blank lines.
 *
 * Models routinely open a reply with `\n\n` (a blank line after a preamble, or just padding).
 * With `white-space: pre-wrap` those are REAL empty lines: in the 90px answer bubble two of them
 * pushed the text a third of the way down, so the box read as "empty with some text at the
 * bottom" - measured at 40 blank pixels above the first line. Trailing whitespace goes the same
 * way: it only ever makes the box look taller than the text inside it.
 *
 * Only the ENDS are touched: internal blank lines are the model's paragraphing and must survive.
 */
function trimAnswer(text) {
  return String(text || '')
    .replace(/^[\s\u00a0]+/, '')
    .replace(/[\s\u00a0]+$/, '');
}

/**
 * Starts the line this frame streams into.
 *
 * The ANSWER box clears first: it shows one answer at a time, so the previous one has
 * to give way to the live text. The PANEL appends instead - it is the transcript, and
 * there the previous turns are the point.
 */
function startHolder(requestId) {
  stopTyper();
  typerQueue = '';
  finalText = null;
  endWhenDrained = false;
  cancelEndTimer();
  if (role === ROLE_ANSWER) els.reply.replaceChildren();

  const line = document.createElement('div');
  line.className = 'msg assistant streaming';
  const node = document.createTextNode('');
  line.appendChild(node);
  els.reply.appendChild(line);
  if (role === ROLE_PANEL) scrollToEnd();

  current = { requestId: requestId || '', line, node, text: '' };
  return current;
}

/* Typewriter: received text is QUEUED and revealed a few characters per tick.
 *
 * Writing straight into `textContent` makes an answer appear in one jump whenever the
 * host delivers it in one piece (a fast model, or the whole answer arriving on `done`).
 * FIXED 1 character / 50ms is the user's choice, and it is now ONLY a display effect:
 * the transcript is written when `done` arrives (see onDone), so the typing pace can
 * never delay what the panel shows or what is stored. Predictable beats clever here -
 * the reveal rate is the thing being judged, so it must not change with the length of
 * the answer.
 *
 * `finalText` is the authoritative text from `done`. Snapping to it when the queue
 * drains (rather than appending it) is what repairs a chunk that was dropped in
 * flight: appending would leave the duplicated or missing fragment on screen. */
let typer = null;
let typerQueue = '';
let finalText = null;
let typerTicks = 0;

/* Set when `done` arrives while characters are still queued: the exchange is over for the
 * TRANSPORT, but not for the screen, and `endExchange` (which hides the question box) must wait
 * for the last character. Without this the question disappeared mid-answer - the same mistake
 * the 1.5.x store made in the other direction, where the transcript write waited for a
 * typewriter that a non-streaming reply never started. */
let endWhenDrained = false;

function enqueueTyper(text) {
  typerQueue += text;
  if (typer) return;
  typer = window.setInterval(() => {
    const chunk = typerQueue.slice(0, 1);
    typerQueue = typerQueue.slice(1);
    if (chunk && current && current.node) {
      // Nothing on screen yet: drop whitespace instead of drawing it. A reply that opens with
      // "\n\n" would otherwise start with two empty lines (see trimAnswer) - and the very first
      // thing the user sees would be a blank bubble.
      const blank = current.node.data === '' && !chunk.trim();
      if (!blank) current.node.data += chunk;
    }
    // The answer box is TOP-aligned now, so a long answer grows past the box and the newest line
    // would slide out of view. Following it here is what keeps "watch it being typed" working.
    if (role === ROLE_ANSWER) scrollToEnd();
    // The box's height follows the text that is actually ON SCREEN, not the text still queued, so
    // it grows with the typing. Every fourth tick (~200ms) is plenty: each step is a re-crop of the
    // window, which the host floors at 500ms anyway.
    if (++typerTicks % 4 === 0) syncAnswerSurface();
    if (typerQueue) return;
    stopTyper();
    if (finalText !== null) {
      if (current && current.node) current.node.data = finalText;
      finalText = null;
    }
    // The snap can change the height (the authoritative text may be longer or shorter): measure
    // once more before the exchange is allowed to end.
    syncAnswerSurface();
    if (endWhenDrained) {
      endWhenDrained = false;
      // The last character is on screen: NOW the exchange is over as far as the user is
      // concerned, so the question box can go (after its grace period, see endExchange).
      endExchange();
    }
  }, 50);
}

// --- surfaces ---------------------------------------------------------------

/**
 * Applies the appearance `init` names, and nothing else.
 *
 * Runs exactly once per frame, after the handshake. Before it, the root class is
 * `view-boot` and NOTHING is painted: the frame is already at its final size, so the
 * alternative (defaulting to the panel appearance) is a visible flicker of a
 * miniature conversation panel inside every floating box.
 */
function applySurface(surface) {
  // The input's placeholder doubles as the build marker (see BUILD). Cheap, and it ends
  // the "did it even update" question at a glance.
  if (els.prompt) {
    els.prompt.placeholder = '输入想说的话… (' + BUILD + ')';
  }

  const kind = surface && surface.kind ? surface.kind : 'panel';
  if (kind === 'surface') {
    // The DECLARATION index, which the host sends as `surface.rectIndex`. It is the
    // job: 0 question, 1 answer, every other index the input pill (a plugin that
    // declared a fourth block would otherwise draw an appearance this file does not
    // have).
    const index = Number(surface.rectIndex) || 0;
    role = index === 0 ? ROLE_QUESTION : index === 1 ? ROLE_ANSWER : ROLE_INPUT;
  } else {
    role = ROLE_PANEL;
  }

  const shape = SHAPE[role];
  els.root.className = shape;
  els.root.dataset.surface = kind;
  els.root.dataset.shape = shape;
  document.documentElement.dataset.surface = kind;

  // Where the tail points. NOT 50%: the host clamps every rectangle into the window, and the
  // pet sits flush against the window's edge, so a block wider than the pet is shifted away
  // from the pet's centre. `rect.tailX` is that centre measured from this rectangle's left
  // edge, computed by the host where both rectangles are known.
  const tailX = surface && surface.rect ? Number(surface.rect.tailX) : NaN;
  if (Number.isFinite(tailX)) {
    els.root.style.setProperty('--tail-x', tailX + 'px');
  } else {
    els.root.style.removeProperty('--tail-x');
  }

  if (role === ROLE_ANSWER) {
    answerSurface = surface;
    answerTailX = tailX;
    drawAnswerBubble(surface, tailX);
  }

  // The list is the transcript in the panel and the single line in the two boxes; only
  // the input pill hides it outright.
  els.reply.hidden = role === ROLE_INPUT;
}

/**
 * Puts the caret in the pill's field.
 *
 * Called from `onInit` AFTER `applyGrants`, and that order matters: the textarea is
 * `disabled` in the markup, and a disabled field cannot take focus - so focusing from
 * `applySurface` (which runs before the grants are applied) silently did nothing, and
 * the floating composer opened without a caret.
 */
function focusComposer() {
  if (role !== ROLE_INPUT || !els.prompt) return;
  if (els.prompt.disabled) return;
  els.prompt.focus();
}

/**
 * Draws the answer box: ONE SVG path behind the text, body and tail together.
 *
 * The path is built here rather than in the stylesheet because the apex sits at the
 * PET's centre (`rect.tailX`), which only the host knows.
 *
 * Why one path: with the bubble and the tail drawn as two shapes, each carried its own
 * outline, so a white line ran across the tail's base - the bubble's bottom border -
 * and the tail looked bolted on. A single contour goes round the bubble, down one side
 * of the tail, around the apex and back up, with nothing in between.
 *
 * Geometry: the block is 100px, the bubble is the top 90 and the bottom 10 is the tail
 * band. Both edges are anchored at the block's bottom, which lands on the pet's head,
 * so the apex touches the pet. Half-width 7, height 10 (the outline adds the 0.5px
 * insets that keep a 1px stroke inside the box).
 */
function drawAnswerBubble(surface, tailX) {
  const rect = surface && surface.rect;
  const card =
    getComputedStyle(document.documentElement).getPropertyValue('--p-card').trim() || '#1d2027';
  const w = rect ? Number(rect.w) || 308 : 308;
  // The frame's CURRENT height, not the one `init` carried: the host resizes this iframe when the
  // answer grows (`surface.blocks` with `sizes`), and a block's document gets no new `init` for
  // that - only a resize. Drawing from the declared height would leave the tail in the middle of a
  // taller bubble, or clip it inside a shorter one.
  const frameH = Math.max(40, Math.round(window.innerHeight) || (rect ? Number(rect.h) || 60 : 60));

  // The bubble sits SHADOW_PAD inside the block, so its drop shadow has somewhere to land (the
  // block is the window region - anything outside is cut away). The stroke centreline then sits
  // 1px inside the bubble's own edge, which is half of the 2px stroke.
  const pad = SHADOW_PAD;
  const left = pad + 1;
  const right = w - pad - 1;
  const top = pad + 1;
  const bubbleBottom = frameH - 10 - 1; // the bottom 10px of the block is the tail band
  const apex = frameH - 1; // the stroke's outer edge just reaches the block's bottom
  const r = 16;
  const half = 7;
  const wanted = Number.isFinite(tailX) ? tailX : w / 2;
  // Keep the apex clear of the rounded corners, or the path crosses itself.
  const x = Math.min(Math.max(wanted, left + r + half + 2), right - r - half - 2);

  const d = [
    `M ${left + r} ${top}`,
    `H ${right - r}`,
    `A ${r} ${r} 0 0 1 ${right} ${top + r}`,
    `V ${bubbleBottom - r}`,
    `A ${r} ${r} 0 0 1 ${right - r} ${bubbleBottom}`,
    `H ${x + half}`,
    `L ${x} ${apex}`,
    `L ${x - half} ${bubbleBottom}`,
    `H ${left + r}`,
    `A ${r} ${r} 0 0 1 ${left} ${bubbleBottom - r}`,
    `V ${top + r}`,
    `A ${r} ${r} 0 0 1 ${left + r} ${top}`,
    'Z',
  ].join(' ');

  let svg = document.getElementById('bubble-shape');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'bubble-shape';
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;z-index:1;pointer-events:none';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    // The white edge is 2px: on a dark wallpaper it is what makes the bubble's outline read, and the
    // shadow is what makes it read on a light one. Both are the user's ask; neither works alone.
    path.setAttribute('stroke', 'rgba(255, 255, 255, 0.95)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    path.style.filter = 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.5))';
    svg.appendChild(path);
    els.root.insertBefore(svg, els.root.firstChild);
  }
  svg.setAttribute('viewBox', `0 0 ${w} ${frameH}`);
  const shapePath = svg.firstChild;
  shapePath.setAttribute('fill', card);
  shapePath.setAttribute('d', d);
}

// --- host frames ------------------------------------------------------------

/**
 * Handles the host's single init frame, which is what unlocks the UI.
 *
 * Also the only place the appearance is decided: before this the document paints
 * nothing at all (see applySurface).
 */
function onInit(data) {
  initialised = true;
  applyTheme(data.theme);
  granted.clear();
  for (const p of data.granted || []) granted.add(p);
  applySurface(data.surface || {});
  applyGrants();
  focusComposer();
  // The composer's own focus is one half of the auto-hide condition, and this is the only document
  // that can see it. `blur` re-arms the timer (measured from when the answer finished); `focus`
  // cancels it, because a caret in the box means the user is writing, not leaving.
  if (role === ROLE_INPUT && els.prompt) {
    els.prompt.addEventListener('focus', cancelAutoHide);
    els.prompt.addEventListener('blur', armAutoHide);
  }
  if (granted.has('storage')) loadHistory();
  loadSettings();
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
  els.prompt.disabled = !canChat;
  // `busy` wins over the grant: one reply at a time, because two overlapping replies
  // would interleave into one paragraph (the host keys deltas by requestId, but a
  // second request would make this frame drop the first one's tail instead).
  els.send.disabled = !canChat || busy;
  els.stop.disabled = !canChat || !busy;
  els.bubble.disabled = !granted.has(PERM_BUBBLE);
  els.surface.disabled = !granted.has(PERM_SURFACE);

  if (!canChat) setStatus('未获授权：llm.chat');
  else setStatus(busy ? '正在回复…' : '已就绪');
}

function setBusy(value) {
  busy = value;
  applyGrants();
}

function setStatus(text) {
  if (els.status) els.status.textContent = text;
}

/**
 * Reads the plugin's own declared settings.
 *
 * Only `llmHistoryTurns` is used from them, and it is used HERE rather than read by
 * the host: how much of the transcript to replay is a conversation-panel decision,
 * while the endpoint, the model and the credential belong to the host's llm.chat
 * path. A settings read that fails leaves the default in place.
 */
function loadSettings() {
  if (!granted.has('plugin.config')) return;
  pendingConfig = request('config.get', {});
}

// The request id whose response carries the stored transcript, so its response
// can be told apart from any other reply.
let pendingHistory = null;

/** Reads the transcript out of the plugin's own storage. */
function loadHistory() {
  if (!granted.has('storage')) return;
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
        // Sticky: an answer seen once stays "there is an answer", so re-reading an older
        // transcript cannot hide the box the user is reading.
        if (!hasAnswer) hasAnswer = !!lastEntry('assistant');
        renderHistory();
        // Open time: the answer box sizes itself to what it just rendered, and decides visibility
        // from it (no answer at all → only the composer under the pet).
        //
        // Only the answer box asks: it is the one frame that can measure, and `surface.blocks`
        // replaces the whole size map, so a second caller would reset the height.
        if (!asking) syncAnswerSurface();
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

/** Persists the transcript to the plugin's own storage. */
function saveHistory() {
  if (!granted.has('storage')) return;
  request('storage.set', { key: HISTORY_KEY, value: JSON.stringify(history) });
}

/** Appends one turn to the transcript. */
function remember(role_, text) {
  history.push({ role: role_, text });
  saveHistory();
}

/**
 * Marks the beginning of a NEW exchange, and reads the transcript once for the question box.
 *
 * Called from every `llm.*` handler, in every appearance, because each block of this plugin is
 * its own document and each one has to maintain its own view of the exchange.
 */
function noteExchange(requestId) {
  const fresh = !!requestId && requestId !== exchangeId;
  if (fresh) {
    exchangeId = requestId;
    questionSynced = false;
    // A new question supersedes any pending "the last one is over" timer: otherwise the previous
    // reply's one-second delay would take down the question box of the exchange that has just
    // started.
    cancelEndTimer();
    // The question box belongs to ONE exchange: whatever it still shows is the previous
    // question, so it is cleared before the new one is read. Without this the box reappears
    // with the old question for as long as the storage round trip takes.
    if (role === ROLE_QUESTION) els.reply.replaceChildren();
  }

  // The QUESTION box knows what was asked only from the transcript: the frame that sent the
  // request is a different document, and the host has no plugin-to-plugin channel. "Once per
  // exchange" is what keeps that from becoming a poll - the flag is cleared above when the
  // first frame of a new request arrives.
  if (role === ROLE_QUESTION && !questionSynced) {
    questionSynced = true;
    loadHistory();
  }

  return fresh;
}

// The answer box's own init payload, kept so the bubble can be redrawn when the host resizes this
// frame (see drawAnswerBubble).
let answerSurface = null;
let answerTailX = NaN;

// The answer box's geometry, in CSS pixels. The manifest declares the FLOOR and the CEILING; the
// height in between is measured from the text (see syncAnswerSurface).
//
//   ANSWER_MIN               the declared h: a two-line bubble. Below that the tail band and the
//                            rounded corners would consume the whole box.
//   ANSWER_CHROME            10px top + 14px bottom of body padding. 10 of the bottom is the tail
//                            band and 4 of it plus the 4 on top are the SHADOW band (SHADOW_PAD),
//                            so box height = text height + 24.
//   ANSWER_MAX               everything the window has above the pet minus a 4px margin
//                            (petY 160 at scale 1; the pet is centred in the 520px window).
//   ANSWER_UNDER_QUESTION    no longer a constant: whether the question strip fits is measured
//                            against the room the host reports (`room`), because that room depends
//                            on the user's 桌宠大小 - 160px at 1.0x, 110px at 1.5x.
const ANSWER_MIN = 60;
const ANSWER_CHROME = 24;
const ANSWER_MAX = 156;

// The question strip's own footprint above the answer block: its 40px height plus the 8px gap.
// Kept here rather than derived from the manifest because it is a LAYOUT relationship between two
// declared blocks, and the two numbers are already coupled to the CSS (applied via `room`).
const QUESTION_BAND = 48;

// A DROP SHADOW HAS TO LIVE INSIDE THE DECLARED RECTANGLE.
//
// The window region is the only place these frames can paint (AGENTS.md §3.2), and an iframe clips
// its own content, so a shadow painted outside the block is simply cut off - the same constraint
// the tail lives under. So each bubble is drawn inset by SHADOW_PAD inside its block, and the band
// the bubble leaves over is where its shadow lands. That is why the answer and input blocks are 308
// wide for a 300-wide bubble.
//
// 4px is the smallest band a tight shadow fits in (`0 2px 4px` spreads ~4px sideways). A softer one
// would need a wider band, and the 160px above the pet cannot spare it.
const SHADOW_PAD = 4;

// The height this box last asked the host for, and the last (hidden, height) pair it asked with.
// `surface.blocks` replaces the host's whole hidden set AND its whole size map, so the pair has to
// be sent together and only when it actually changed.
let answerHeight = 0;
let lastSurfaceAsk = '';

/** How tall the answer TEXT is, independent of the box it currently sits in. */
function measureAnswerText() {
  const line = els.reply.firstElementChild;
  if (!line) return 0;
  // The line element, not the scroll container: `scrollHeight` of a box that is too TALL reports
  // the box, so a short answer after a long one could never shrink it back.
  return Math.ceil(line.getBoundingClientRect().height);
}

/**
 * The free space above the pet, in CSS pixels.
 *
 * Everything the floating blocks use lives in that band, and how much of it exists is the user's
 * 桌宠大小: the pet is centred in the window, so 1.0x leaves 160px and 1.5x leaves 110. A plugin
 * cannot measure it from inside its own frame, so the host sends it with every rectangle (`room`).
 *
 * A stale value here is what made a bigger pet cut the answer off: the block asked for 156px in a
 * 110px band, the window could not hold it, and the top of the bubble was cropped mid-line.
 */
function answerRoom() {
  const rect = answerSurface && answerSurface.rect;
  const room = rect ? Number(rect.room) : NaN;
  if (Number.isFinite(room) && room > ANSWER_MIN) return room;
  return 160; // an older host that does not send `room`: the band at the default pet size
}

/**
 * The ONE frame that decides the surface's shape: the answer box.
 *
 * Earlier versions had every content frame send `surface.blocks`, on the theory that they would
 * all compute the same set. That is true for the hidden set, but it cannot carry the height: the
 * question box has no idea how tall the answer is, and the payload replaces the whole size map -
 * so its call would reset the answer to its declared floor. One owner, and it happens to be the
 * frame that knows everything needed here:
 *
 *   - it renders the answer, so it can measure it;
 *   - it sees `llm.delta` / `llm.done` / `llm.error`, so it knows when an exchange starts and ends;
 *   - it reads the transcript at open time, so it knows whether there is an answer to show.
 *
 * Three things come out of that measurement, all against `room` rather than a fixed 160px band:
 *
 *   height   the text height + chrome, clamped to [MIN, manifest maxH] and to what the band above
 *            the pet can hold (`room - 4`). Clamping here means the request FITS, so the host never
 *            has to crop it - the box scrolls instead of being cut off at the top.
 *   hidden   block 0 (the question) is hidden once the exchange is over, AND whenever it no longer
 *            fits above this block (`questionFits`). Block 1 (this box) is hidden when there is no
 *            answer to show at all.
 */
function syncAnswerSurface() {
  if (role !== ROLE_ANSWER) return;
  if (!granted.has(PERM_SURFACE)) return;

  const room = answerRoom();
  // The manifest's maxH is the host's ceiling; the band is the physical one. Whichever is smaller.
  const ceiling = Math.max(ANSWER_MIN, Math.min(ANSWER_MAX, room - 4));
  const text = measureAnswerText();
  const height = Math.max(ANSWER_MIN, Math.min(ceiling, text + ANSWER_CHROME));
  // The question strip needs its own 40px plus the 8px gap above this block's top.
  const questionFits = height + QUESTION_BAND <= room;

  const hidden = [];
  if (!asking || !questionFits) hidden.push(0);
  if (!asking && !hasAnswer) hidden.push(1);

  const ask = JSON.stringify([hidden, height]);
  if (ask === lastSurfaceAsk) return;
  lastSurfaceAsk = ask;
  answerHeight = height;
  request('surface.blocks', { hidden, sizes: { 1: height } });
}

/**
 * Ends the visible exchange: the question box goes away, one second after the answer finished
 * being DISPLAYED.
 *
 * ONLY the answer box calls this, and only once its display has finished. Two separate delays
 * have been wrong here already, so both are spelled out:
 *
 *   - `llm.done` is NOT the moment. The typewriter runs at 1 character / 50ms, so the transport
 *     can be ten seconds ahead of what the user is reading; hiding there made the question
 *     vanish mid-answer.
 *   - the last character is not the moment either (user's call). The question is the context for
 *     the answer that just landed, and having it disappear on the same frame as the last
 *     character reads as a flicker. One second of "here is the question, here is its answer"
 *     makes the turn readable as a pair.
 *
 * The timer is cancelled by the next exchange (see noteExchange), so a follow-up question inside
 * that second cannot have its own question box taken down by the previous reply.
 */
const END_DELAY_MS = 1000;
let endTimer = null;

function cancelEndTimer() {
  if (endTimer !== null) window.clearTimeout(endTimer);
  endTimer = null;
}

function endExchange() {
  if (role !== ROLE_ANSWER) return;
  cancelEndTimer();
  endTimer = window.setTimeout(() => {
    endTimer = null;
    asking = false;
    // The question box is gone, so the answer may now use the whole band above the pet: this is
    // the second half of the two-phase height (see syncAnswerSurface).
    syncAnswerSurface();
  }, END_DELAY_MS);
}

// --- auto-hide: an answer that has been read for a few seconds ---------------
//
// The floating surface used to stay up until the user right-clicked the pet, which is a gesture
// nowhere near the conversation: it reads as "the chat window cannot be closed". This closes it
// once the turn is over and nobody is using it.
//
// WHY THE INPUT FRAME OWNS THIS. The three floating frames are three separate opaque documents, so
// "the composer has focus" is only knowable in the one that HOLDS the composer. All three receive
// the same `llm.*` events from the host, so this frame also knows when the answer finished - which
// makes it the only place where both halves of the condition can be true at once.
//
// BOTH HALVES ARE REQUIRED, and each has its own failure mode without the other:
//   - hiding on the timer alone would take the window away from someone mid-sentence, because a
//     focused composer is a user who is typing, not a user who has left;
//   - hiding on blur alone would cut off an answer that is still arriving, because clicking away
//     while the model is still talking is not the same as being finished with it.
const AUTO_HIDE_MS = 3000;
// When the last answer finished. 0 means "nothing to hide yet".
let answerFinishedAt = 0;
let autoHideTimer = null;

function cancelAutoHide() {
  if (autoHideTimer !== null) window.clearTimeout(autoHideTimer);
  autoHideTimer = null;
}

/** Whether the caret is in the composer, i.e. the user is writing rather than reading. */
function composerFocused() {
  const active = document.activeElement;
  return !!active && (active === els.prompt || (els.prompt && els.prompt.contains(active)));
}

/**
 * Arms (or re-arms) the hide, measured from when the answer finished rather than from now.
 *
 * Both the "answer finished" path and the "focus left" path call this, and measuring from
 * `answerFinishedAt` is what makes them the same delay instead of two that add up: leaving the
 * composer 10 s after an answer hides the window at once, leaving it 1 s after hides it after 2.
 */
function armAutoHide() {
  if (role !== ROLE_INPUT) return;
  // No grant, no close: `surface.hide` would be refused, and a plugin that kept asking would fill
  // the status line with a refusal it cannot act on.
  if (!granted.has(PERM_SURFACE)) return;
  if (!answerFinishedAt) return;
  cancelAutoHide();
  const wait = Math.max(0, AUTO_HIDE_MS - (Date.now() - answerFinishedAt));
  autoHideTimer = window.setTimeout(() => {
    autoHideTimer = null;
    if (composerFocused()) return; // the user came back
    // `busy`, NOT `asking`. `asking` is cleared only by the ANSWER frame's own end-of-exchange
    // timer (`endExchange` returns immediately in every other role), so in THIS frame it stayed
    // true for ever after the first message - and the hide was skipped every single time. `busy` is
    // set and cleared by the frame that actually sent the request, which is this one.
    if (busy) return; // another question is in flight
    request('surface.hide', {});
  }, wait);
}

/** Called by the input frame when a turn ends, so the clock starts from the answer, not the click. */
function noteAnswerShown() {
  if (role !== ROLE_INPUT) return;
  answerFinishedAt = Date.now();
  armAutoHide();
}


/**
 * Sends what is in the composer.
 *
 * The panel and the input pill both do this; the question and answer boxes have no
 * composer (`canCompose`).
 *
 * The question line is drawn only where a transcript is shown (the panel). The two
 * floating boxes learn about it from the transcript instead - the question box reads
 * it once, and the answer box does not show questions at all.
 */
// --- the reply lifecycle ----------------------------------------------------

function sendPrompt() {
  if (!canCompose()) return;
  const text = els.prompt.value.trim();
  if (!text) return;
  if (!granted.has(PERM_CHAT)) return;
  if (busy) return;

  if (role === ROLE_PANEL) appendLine('user', text);
  remember('user', text);
  els.prompt.value = '';
  lastReplyText = '';

  const requestId = nextId();
  endedRequestId = null;
  ownRequestId = requestId;
  setBusy(true);

  // The QUESTION box belongs to the next exchange; it is NOT shown here. Showing it at send
  // time would flash whatever the box still holds - the PREVIOUS question - for as long as the
  // first chunk takes to arrive, because this frame cannot draw into that document. The first
  // chunk is when the question box knows its own new text (it clears and re-reads at the same
  // moment), so that is when both content boxes come up, together.
  //
  // Only the panel sends without a surface: `surface.blocks` is refused in that state, so
  // nothing here may touch visibility for it.

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

function canCompose() {
  return role === ROLE_PANEL || role === ROLE_INPUT;
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
 * Appends one streamed chunk.
 *
 * A chunk for a superseded request is dropped, never appended: with two overlapping
 * replies it would otherwise interleave into one paragraph.
 *
 * The FIRST chunk of an exchange is also the moment the surface changes shape: the question
 * box comes back on top and the answer box (which was showing the previous answer) starts over.
 * The answer box is the frame that asks for that shape, because it is the frame that can also
 * measure how tall the answer is going to be (see syncAnswerSurface).
 */
function onDelta(payload) {
  const requestId = payload && payload.requestId;
  const text = payload && payload.text;
  if (!text) return;

  const fresh = noteExchange(requestId);
  if (fresh) asking = true;

  if (role !== ROLE_PANEL && role !== ROLE_ANSWER) return;
  let hold = hasLiveHolder() ? current : null;
  if (!hold) {
    // A reply this frame already finished or abandoned is refused rather than adopted
    // again, which is what keeps a late delta from `stop` rebuilding the line.
    if (requestId && requestId === endedRequestId) return;
    hold = startHolder(requestId);
    // The box was cleared for the new answer: put it back to its smallest, and bring the
    // question box up for its exchange.
    if (role === ROLE_ANSWER) syncAnswerSurface();
  }
  if (requestId && hold.requestId && requestId !== hold.requestId) return;

  hold.text += text;
  if (role === ROLE_ANSWER) {
    enqueueTyper(text);
  } else {
    // The panel shows the accumulated text, without the blank lines a reply likes to open with
    // (see trimAnswer). `hold.text` keeps the raw text; only the view is trimmed.
    hold.node.data = trimAnswer(hold.text);
    scrollToEnd();
  }
}

/**
 * Ends the reply with the AUTHORITATIVE full text.
 *
 * The done frame carries the whole answer, so when it disagrees with what the
 * deltas accumulated - a chunk dropped in flight, a retry that re-sent the
 * tail - the displayed text is REPLACED rather than appended to.
 *
 * The TRANSCRIPT IS WRITTEN HERE, not when the answer finished being typed out: the
 * typewriter is a display effect in the answer box, and the store must not wait for a
 * 20-characters-per-second animation. (The 1.5.x code deferred the write to the end of
 * the typing, and when `done` arrived with an empty queue - a non-streaming answer -
 * the deferred callback was never called and the turn was never stored at all.)
 */
function onDone(payload) {
  const requestId = payload && payload.requestId;
  // Trimmed once, here: this is the authoritative text, and it is what gets stored, snapped on
  // screen and seeded into the bubble line.
  const full = trimAnswer(payload && typeof payload.text === 'string' ? payload.text : '');
  noteExchange(requestId);

  // `ownRequestId` is how a frame knows it is the one that asked. A done frame without
  // an id can only be ours if we are the only one who sent something.
  const mine = !!ownRequestId && (!requestId || requestId === ownRequestId);

  if (role === ROLE_PANEL || role === ROLE_ANSWER) {
    let hold = hasLiveHolder() ? current : null;
    if (!hold) {
      if (!(requestId && requestId === endedRequestId)) hold = startHolder(requestId);
    }
    if (hold) {
      hold.text = full || hold.text;
      hold.line.classList.remove('streaming');
      if (role === ROLE_PANEL) {
        hold.node.data = trimAnswer(hold.text);
        scrollToEnd();
      } else if (typerQueue) {
        // Let the queue drain first, then snap to the truth (see enqueueTyper).
        finalText = trimAnswer(hold.text);
      } else {
        hold.node.data = trimAnswer(hold.text);
      }
    }
  }

  if (mine) {
    ownRequestId = null;
    setBusy(false);
    lastReplyText = full;
    if (full) remember('assistant', full);
  }

  endedRequestId = requestId || endedRequestId;

  // `done` ends the REQUEST, not the display. The answer box hides the question box, and only
  // once the last character of the answer is on screen (see endWhenDrained): hiding here would
  // make the question vanish while the answer was still being typed out, which is exactly the
  // moment the question is still doing its job.
  hasAnswer = true;
  if (role === ROLE_ANSWER) {
    if (typerQueue) {
      // Both the height and the hide wait for the last character (see the typer's drain branch).
      endWhenDrained = true;
    } else {
      // Nothing to type out: the text on screen is final, so measure it and start the grace period.
      syncAnswerSurface();
      endExchange();
    }
  }
  // The input frame's own clock for closing the whole surface. It starts at `done` rather than at
  // the last character because that frame has no typewriter to watch - and the answer box's own
  // END_DELAY has already kept the pair on screen for a second by then.
  noteAnswerShown();
}

/**
 * Shows a failure the user must see.
 *
 * The panel and the answer box both have a visible message list, so the line goes
 * there - on the answer box it REPLACES the answer slot, which is right: that box
 * shows the current turn, and the current turn failed.
 *
 * The input pill has no visible list at all, so a line appended there would be
 * invisible. It hands the text to the pet's speech bubble instead, which is the only
 * surface that frame can actually draw.
 */
function onError(payload) {
  const requestId = payload && payload.requestId;
  const why = (payload && (payload.message || payload.error || payload.code)) || '未知错误';
  noteExchange(requestId);

  if (role === ROLE_ANSWER) {
    // A failed request must not leave the box stuck on the previous answer: the box is
    // the current turn, and this turn failed.
    stopTyper();
    typerQueue = '';
    finalText = null;
    current = null;
    els.reply.replaceChildren();
    appendLine('system', '请求失败：' + why);
  } else if (role === ROLE_PANEL) {
    if (current) current.line.classList.remove('streaming');
    current = null;
    appendLine('system', '请求失败：' + why);
  } else if (role === ROLE_INPUT) {
    request('bubble.say', { text: '对话失败：' + why });
  }

  if (ownRequestId) {
    ownRequestId = null;
    setBusy(false);
  }
  endedRequestId = requestId || endedRequestId;

  // An error has nothing to type out - the failure text is on screen the moment it is appended -
  // so this is the one end-of-exchange that does not wait for the typewriter. `hasAnswer` keeps
  // the box that is showing the reason from hiding itself.
  hasAnswer = true;
  if (role === ROLE_ANSWER) {
    endWhenDrained = false;
    syncAnswerSurface();
    endExchange();
  }
  // A FAILED turn is also a finished one: the reason is on screen, so the same "nothing more is
  // coming, close it once the user has had a few seconds" applies. `hasAnswer` above is what keeps
  // the answer box showing the reason while the clock runs.
  noteAnswerShown();
}

/**
 * Shows what the pet is doing while the model runs a tool.
 *
 * Without this the panel's status line sits on "正在回复…" for the whole loop and then
 * jumps to the answer, which reads as a stall rather than as work. With tools the
 * answer can be four rounds away.
 *
 * A FAILED tool is reported as a status line, not through onError: the model receives
 * the failure too and goes on to answer, so a red "对话失败" would be describing a
 * conversation that is still happening.
 */
function onTool(payload) {
  const requestId = payload && payload.requestId;
  if (requestId && ownRequestId && requestId !== ownRequestId) return;
  const label = TOOL_STATUS[payload.name] || payload.name || '工具';
  setStatus(payload.ok === false ? label + '时出错了' : label + '…');
}

/**
 * Abandons the reply in flight.
 *
 * The request id is remembered as ENDED, which is what stops a frame that arrives late
 * - a trailing delta after `stop`, a duplicate `done` - from building a fresh line.
 * What is already on screen stays: the user dismissed the rest, not what arrived.
 */
function stopReply() {
  if (current) {
    current.line.classList.remove('streaming');
    endedRequestId = current.requestId || endedRequestId;
  }
  if (role === ROLE_ANSWER) {
    stopTyper();
    typerQueue = '';
    finalText = null;
  }
  if (ownRequestId) {
    endedRequestId = ownRequestId;
    ownRequestId = null;
    setBusy(false);
  }
  current = null;
  setStatus('已停止');
}

/**
 * Applies a rectangle the host says has changed.
 *
 * `init` carries this frame's rectangle once, and a surface frame then outlives many geometry
 * passes: the user resizes the pet, the answer box grows, the window's side flips. Two values go
 * stale in all of those, and both are visible - `tailX` (the apex points at where the pet used to
 * be) and `room` (how much band there is above the pet, which decides this box's ceiling). The host
 * sends them again instead of rebuilding the frame, so this is the only place that catches up.
 */
function applyRect(rect) {
  if (!rect) return;
  if (answerSurface) answerSurface = { ...answerSurface, rect };

  const tailX = Number(rect.tailX);
  if (Number.isFinite(tailX)) {
    answerTailX = tailX;
    els.root.style.setProperty('--tail-x', tailX + 'px');
  }

  if (role !== ROLE_ANSWER) return;
  drawAnswerBubble(answerSurface, answerTailX);
  // A new room means a new ceiling: forget the last ask so the re-measure is actually sent.
  lastSurfaceAsk = '';
  syncAnswerSurface();
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
    case 'surface':
      // The host moved or resized this block without rebuilding the frame (see applyRect).
      applyRect(data.rect);
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

/** Shows the last reply in the pet's speech bubble (panel only). */
function sayInBubble() {
  if (!granted.has(PERM_BUBBLE)) return;
  const line = (lastReplyText || '').split('\n')[0].trim();
  request('bubble.say', { text: line || '你好，我是对话插件。' });
}

/**
 * Asks the host to show or hide the floating surface.
 *
 * The plugin never places its own blocks: each one is a window region the host
 * cropped, so this only says whether the surface should be on screen. A plugin
 * whose surface permission was not granted cannot turn it on at all.
 *
 * Which BLOCKS are visible, and how tall the answer box is, are a different question - handled by
 * syncAnswerSurface, from the answer box itself. A hidden block keeps its frame and its document
 * now, so hiding is a safe operation rather than a teardown.
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

// The host resizes this iframe when the answer box grows or shrinks (there is no second `init` for
// a geometry change), so the bubble's SVG has to be redrawn at the new height.
//
// It also RE-ASKS for the surface's shape. A resize means the host changed the block under this
// document, and nothing else would ever tell it: the frames are reused when the surface is re-opened,
// and a re-open restarts the host from the manifest's defaults. Re-asking is idempotent - a resize
// caused by our own request measures to the same number and stops - but the last ask has to be
// forgotten first, or the "nothing changed, do not ask again" guard would suppress exactly the
// request that repairs it.
window.addEventListener('resize', () => {
  if (!answerSurface) return;
  drawAnswerBubble(answerSurface, answerTailX);
  lastSurfaceAsk = '';
  syncAnswerSurface();
});

// Handshake step one. The host answers with exactly one `init`, and until it lands the
// document paints nothing at all (`view-boot` in panel.html) and every control stays
// disabled.
postToHost({ v: 1, type: 'ready' });
