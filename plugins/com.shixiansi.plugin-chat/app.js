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
  // 图片地址输入框：只有面板（对话页）有它，两个浮动块是固定小矩形，塞不下。
  imgurl: document.getElementById('imgurl'),
  status: document.getElementById('status'),
  send: document.getElementById('send'),
  stop: document.getElementById('stop'),
  surface: document.getElementById('surface'),
};

// Permission names, spelled once. A typo here would silently disable a control
// the user did grant.
const PERM_CHAT = 'llm.chat';
const PERM_SURFACE = 'pet.surface';

/* The build this document came from, shown in the input placeholder.
 *
 * A plugin frame is reloaded only when its version changes AND the surface is re-opened, so
 * "no visible change" has two very different causes: the code did not run, or it ran and did
 * nothing. Every check this session had to be re-derived from screenshots because there was no
 * way to see which build was on screen - this makes that a glance. Keep it in step with
 * manifest.json's version. */
const BUILD = '1.8.3';

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
// True when the CONTROL CENTER mounts this document (its 插件 page hands us
// surface.slot === 'workshop'). This program is not the pet: it makes no model request, so the
// composer is read-only here and says where to type. See applyGrants.
let workshop = false;
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
  // The management window says so in the slot name, which is the host's own vocabulary for
  // "which appearance of you is this". It matters below: `llm.chat` is served by the PET only.
  workshop = !!(surface && surface.slot === 'workshop');
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
  if (granted.has('storage')) loadHistory();
  loadSettings();
  refreshBorrowed();
}

/**
 * 兜底链的驱动器。
 *
 * 状态很小：当前链、走到第几级、这一轮用过的 requestId。每一级都发一个**新的** requestId
 * （宿主按它分流 delta/error），所以链内切换不会和上一级的流混在一起。
 */
let chain = [];
let chainIndex = 0;
let chainIds = new Set();
/** 借来的渠道：`{id, channel}`，来自 llm.providers；没有就不走这一级。 */
let borrowLender = null;
let pendingProviders = null;
/** 最近一次提问的原文：最后一级也失败时放回输入框，用户按一下就能重发。 */
let lastPrompt = '';

function refreshBorrowed() {
  // 控制中心不服务 `llm.providers`（手册 §9：它没有宠物窗口、没有模型预算）。这一页也不能
  // 发消息，所以「借用谁的模型」在这一面根本没有用处——而发出去必被拒，那次拒绝会在宿主日志里
  // 留一行 WARN。这个插件在真机上就是这么把市场日志刷出 4 行的。按 `workshop` 判断而不是
  // 「问一次被拒再兜底」：后者让界面好看，日志照旧。
  if (workshop) return;
  if (!granted.has('llm.borrow')) return;
  const id = request('llm.providers', {});
  if (id) pendingProviders = id;
}

/** 从 llm.providers 的结果里挑一个"现在就能答"的渠道（跳过自己）。 */
function takeBorrowed(result) {
  const rows = (result && Array.isArray(result.providers)) ? result.providers : [];
  const ready = rows.find((row) => row && row.ready && !row.self && row.id);
  if (!ready) return null;
  const channel = ready.defaultChannel
    || (Array.isArray(ready.channels) && ready.channels[0] && ready.channels[0].id)
    || '';
  return { id: ready.id, channel };
}

/** 上下文减半：只用于"上下文太长"那类错误，不换级。 */
function halfHistory() {
  const turns = replayTurns();
  return turns.slice(Math.floor(turns.length / 2));
}

/** 把用户填的图片地址读出来（只认 http/https，最多 4 张，和宿主的规则一致）。 */
function pendingImages() {
  if (role !== ROLE_PANEL || !els.imgurl) return [];
  const raw = String(els.imgurl.value || '').trim();
  if (!raw) return [];
  return raw
    .split(/[\s,，]+/)
    .filter((item) => /^https?:\/\//i.test(item))
    .slice(0, 4);
}

/** 开始一次带兜底的提问。 */
function startExchange(base) {
  chain = buildAttemptChain({
    base,
    borrowed: granted.has('llm.borrow') ? borrowLender : null,
    fallbackModel: fallbackModelName(),
    primaryModel: primaryModelName(),
    hasImages: Array.isArray(base.images) && base.images.length > 0,
    imageModel: imageModelName(),
  });
  chainIndex = 0;
  chainIds = new Set();
  fireAttempt();
}

function fireAttempt() {
  const step = chain[chainIndex];
  if (!step) return;
  if (step.local) {
    finishLocally('');
    return;
  }
  const requestId = nextId();
  ownRequestId = requestId;
  chainIds.add(requestId);
  setBusy(true);
  request('llm.chat', { ...step.payload, requestId });
  if (chainIndex === 0) setStatus('正在回答…');
  else setStatus(`${step.why}，改用${TIER_LABEL[step.tier] || step.tier}…`);
}

/**
 * 最后一级：不发请求，把失败说清楚。
 *
 * 不往对话记录里塞一条假的"助手消息"——那会污染下一轮的历史，让模型以为它说过这句话。
 * 原文放回输入框，状态行写原因，用户按一下就能重发。
 */
function finishLocally(why) {
  setBusy(false);
  asking = false;
  if (lastPrompt && els.prompt && !els.prompt.value.trim()) els.prompt.value = lastPrompt;
  const detail = why ? `（${why}）` : '';
  // 面板里留一行**提示**（不是伪造的助手消息）：用户看的是这段记录，只把失败写在状态行上
  // 等于没写。这一行还说清试过几级，免得他以为是第一次就失败了。
  if (role === ROLE_PANEL) {
    const tried = Math.max(1, chain.filter((step) => !step.local).length);
    appendLine('system', `请求失败：${why || '未知错误'}（已试过 ${tried} 级兜底）`);
  }
  setStatus(`没连上模型${detail}：检查接口地址/模型/密钥，或在「模型渠道」里配一个渠道让我借用`);
}


/**
 * Applies the granted set to the controls.
 *
 * Missing permissions are stated rather than hidden: a greyed-out control with
 * the reason visible is how the user learns that the plugin wants more than
 * they allowed.
 */
function applyGrants() {
  // `workshop` ALSO takes the composer away, and the reason is not a permission the user can
  // grant: the model request is made by the host that owns the plugin's budget and its
  // credential, and the control center deliberately does not serve `llm.chat` (a second LLM
  // path in a second program, with a second writer of the usage file). So this window shows
  // the transcript and says where to type - a disabled box with no explanation would look
  // like a bug in the plugin.
  const canChat = granted.has(PERM_CHAT) && !workshop;
  els.prompt.disabled = !canChat;
  // `busy` wins over the grant: one reply at a time, because two overlapping replies
  // would interleave into one paragraph (the host keys deltas by requestId, but a
  // second request would make this frame drop the first one's tail instead).
  els.send.disabled = !canChat || busy;
  els.stop.disabled = !canChat || !busy;
  // `surface.show` is the pet's: asking the pet to open something is meaningless from here.
  els.surface.disabled = workshop || !granted.has(PERM_SURFACE);

  if (workshop) setStatus('这里只显示记录；发送请在桌宠旁的对话浮层面');
  else if (!canChat) setStatus('未获授权：llm.chat');
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
  if (data.id && data.id === pendingProviders) {
    pendingProviders = null;
    borrowLender = data.ok ? takeBorrowed(data.result) : null;
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
// nowhere near the conversation: it reads as "the chat window cannot be closed". This closes it once
// the turn is over and nobody is using it.
//
// WHY THE INPUT FRAME OWNS THIS. The three floating frames are three separate opaque documents, so
// "the composer has focus" is only knowable in the one that HOLDS the composer. All three receive the
// same `llm.*` events from the host, so this frame also knows when the answer finished - which makes
// it the only place where both halves of the condition can be true at once.
//
// BOTH HALVES ARE REQUIRED, and each has its own failure mode without the other:
//   - hiding on the timer alone would take the window away from someone mid-sentence, because a
//     focused composer is a user who is typing, not a user who has left;
//   - hiding on "focus is elsewhere" alone would cut off an answer that is still arriving, because
//     clicking away while the model is still talking is not the same as being finished with it.
//
// WHY THIS POLLS INSTEAD OF LISTENING FOR `blur`. The first version subscribed to the composer's
// `blur` and was reported as 「完全不会收起」 - and then, after the flag bug was fixed, still did
// nothing when the user clicked the desktop. A `blur` inside an opaque-origin iframe whose whole
// WINDOW is losing focus is not something to rely on: the OS deactivates our layered window, and
// whether Chromium forwards that into the child document is an implementation detail I cannot make a
// product decision depend on. `document.hasFocus()` is a QUERY, so it answers the same question
// whether or not an event was ever delivered.
const AUTO_HIDE_MS = 3000;
// Half a second is far below the 3 s the user actually perceives, so the delay they measure is the
// three seconds they were told, not three seconds plus a poll interval.
const AUTO_HIDE_POLL_MS = 500;
// When the last answer finished. 0 means "nothing to hide yet".
let answerFinishedAt = 0;
let autoHidePoll = null;

/**
 * Whether the caret is in the composer, i.e. the user is writing rather than reading.
 *
 * Kept alongside `document.hasFocus()` rather than folded into it: focus can move to another block of
 * the SAME surface (the answer bubble), which is still the user paying attention to the conversation.
 */
function composerFocused() {
  const active = document.activeElement;
  return !!active && (active === els.prompt || (els.prompt && els.prompt.contains(active)));
}

/** Whether anything in this document still has the user's attention. */
function documentFocused() {
  // WebView2 keeps the document focused while our window is active; clicking the desktop drops it.
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

function stopAutoHidePoll() {
  if (autoHidePoll !== null) window.clearInterval(autoHidePoll);
  autoHidePoll = null;
}

/**
 * Watches for "the turn is over and the user has gone", and closes the surface when both hold.
 *
 * Measuring the delay from `answerFinishedAt` rather than from the moment focus left is what makes
 * the two halves one delay instead of two that add up: leaving 10 s after an answer closes at once,
 * leaving 1 s after closes 2 s later.
 */
function startAutoHidePoll() {
  if (role !== ROLE_INPUT) return;
  // No grant, no close: `surface.hide` would be refused, and a plugin that kept asking would fill the
  // status line with a refusal it cannot act on.
  if (!granted.has(PERM_SURFACE)) return;
  if (autoHidePoll !== null) return;
  autoHidePoll = window.setInterval(() => {
    if (!answerFinishedAt) return;
    // `busy`, NOT `asking`. `asking` is cleared only by the ANSWER frame's own end-of-exchange timer
    // (`endExchange` returns immediately in every other role), so in THIS frame it stayed true for
    // ever after the first message - and the hide was skipped every single time. `busy` is set and
    // cleared by the frame that actually sent the request, which is this one.
    if (busy) return;
    if (Date.now() - answerFinishedAt < AUTO_HIDE_MS) return;
    if (documentFocused() && composerFocused()) return; // the user is still here
    stopAutoHidePoll();
    answerFinishedAt = 0;
    request('surface.hide', {});
  }, AUTO_HIDE_POLL_MS);
}

/** Called by the input frame when a turn ends, so the clock starts from the answer, not the click. */
function noteAnswerShown() {
  if (role !== ROLE_INPUT) return;
  answerFinishedAt = Date.now();
  startAutoHidePoll();
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

  const requestId = nextId();
  endedRequestId = null;
  ownRequestId = requestId;
  setBusy(true);
  lastPrompt = text;

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
  // 带图提问：`images` 是 http(s) 地址（宿主要求），配了 `llmImageModel` 就这一轮换成它。
  // 地址必须来自接口地址的域名或「图片允许的域名」，否则宿主会拒绝——这里先清掉输入框，
  // 免得用户以为没发出去。
  const images = pendingImages();
  const base = { text, history: replayTurns(), tools: TOOLS };
  if (images.length) {
    base.images = images;
    const vision = imageModelName();
    if (vision) base.model = vision;
    if (els.imgurl) els.imgurl.value = '';
  }
  // 兜底链：主模型 → 备用模型 → 借来的渠道 → 本地兜底（见上面的注释）。
  startExchange(base);
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

// --- 兜底链 ------------------------------------------------------------------
//
// 为什么需要它：以前一次提问只有一条路——自己的端点、自己的模型、一次超时 90 秒。任何一步出
// 问题（模型下线、429、余额不足、断网、上下文太长），用户看到的就是一句"对话失败"，而他手里
// 明明还有别的选择：同一服务商的便宜模型、隔壁「模型渠道」插件里配好的渠道，或者至少一句人话。
//
// 链的顺序是**从最像到最不像**，每一级都要能独立说清"为什么走到这一步"：
//
//   1. primary         自己的端点 + 自己的模型（正常情况，永远不会被跳过）
//   2. trimmed         同一级，但上下文减半（只用于"上下文太长 / 超 token"这类错误）
//   3. fallback-model  同一个端点换 `llmFallbackModel`（模型下线、额度用完时最有效）
//   4. borrowed        借别的插件声明的渠道（要 llm.borrow，且对方现在就绪）
//   5. local           不发请求，给一句本地兜底话术，并把失败原因写进状态行
//
// 两条纪律：
//   · **只有"换一级可能有用"的错误才往下走**。401/403 是密钥问题，换模型没用，但换渠道有用，
//     所以它跳过 primary 直接去 borrowed；"上下文太长"则原地重试一次（上下文减半），不换级。
//   · **已经收到的半截回答不丢**。切下一级之前把当前文本留在屏幕上，只加一条"已切换"的提示，
//     而不是清空重来——用户已经读到的字不该因为一次重试消失。

/** 一次提问的兜底链。纯函数：同样的输入永远同样的链，不看全局状态（测试直接调它）。 */
function buildAttemptChain(input) {
  const { base, borrowed, fallbackModel, primaryModel, hasImages, imageModel } = input || {};
  const steps = [{ tier: 'primary', why: '', payload: { ...base } }];
  const fallback = String(fallbackModel || '').trim();
  if (fallback && fallback !== String(primaryModel || '').trim()) {
    steps.push({ tier: 'fallback-model', why: '主模型没答上来', payload: { ...base, model: fallback } });
  }
  if (borrowed && borrowed.id) {
    steps.push({
      tier: 'borrowed',
      why: '自己的配置没答上来',
      payload: { ...base, provider: borrowed.id, channel: borrowed.channel || undefined },
    });
  }
  // `hasImages` 可以显式传，也可以从 payload 里推出来——少一种"调用方忘了传"的错法。
  const withImages = typeof hasImages === 'boolean'
    ? hasImages
    : Array.isArray(base && base.images) && base.images.length > 0;
  const localWhy = withImages && !String(imageModel || '').trim() ? '没有配置图片模型' : '';
  steps.push({ tier: 'local', why: localWhy, local: true });
  return steps;
}

/**
 * 这个错误值不值得换下一级，以及换哪种。
 *
 * 返回分类名而不是布尔："上下文太长"要用**同一级 + 更少上下文**重试，别的错误才换级。
 */
function classifyFailure(error) {
  const text = String((error && (error.message || error.code || error)) || '');
  if (!text) return 'unknown';
  if (/401|403|unauthor|invalid.*(key|token)|api[ _-]?key/i.test(text)) return 'auth';
  if (/429|rate[ _-]?limit|quota|insufficient|余额|额度|限流/i.test(text)) return 'quota';
  if (/timeout|timed[ _-]?out|超时|ECONN|ENOTFOUND|network|fetch failed|连接/i.test(text)) return 'network';
  if (/context|too[ _-]?long|maximum.*token|token.*(limit|length)|超过.*长度|上下文/i.test(text)) return 'context';
  if (/\b5\d\d\b|overload|busy|capacity|server error|服务(器)?错误/i.test(text)) return 'server';
  if (/model|not[ _-]?found|does not exist|unsupported|不存在|不支持/i.test(text)) return 'model';
  return 'unknown';
}

/** 每一级在界面上叫什么。状态行要能被人读懂，而不是显示内部枚举。 */
const TIER_LABEL = {
  primary: '主模型',
  'fallback-model': '备用模型',
  borrowed: '借来的渠道',
  local: '本地兜底',
};

/** 带图提问时用哪个模型：`llmImageModel` 优先，没有就沿用主模型（有些模型本身多模态）。 */
function imageModelName() {
  return String(settings.llmImageModel || '').trim();
}

/** 备用模型名（主模型失败时换它）。 */
function fallbackModelName() {
  return String(settings.llmFallbackModel || '').trim();
}

/** 主模型名——只用于"要不要换"的比较，真正的模型由宿主决定。 */
function primaryModelName() {
  return String(settings.llmModel || '').trim();
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

  // 兜底链先看一眼：这一轮（自己发起的请求）失败时，能换下一级就换，而不是直接把
  // "对话失败"甩给用户。只有链上最后一个请求的失败才会走到下面的常规处理。
  if (requestId && chainIds.has(requestId) && requestId === ownRequestId) {
    const kind = classifyFailure(payload);
    const step = chain[chainIndex] || {};
    if (kind === 'context' && !step.trimmed) {
      // 上下文太长：**原地**重试一次，历史减半。换模型帮不上这件事。
      step.trimmed = true;
      step.payload = { ...step.payload, history: halfHistory() };
      fireAttempt();
      return;
    }
    if (chainIndex < chain.length - 1) {
      chainIndex += 1;
      const next = chain[chainIndex];
      if (next.local) {
        finishLocally(why);
        return;
      }
      setStatus(`${step.tier === 'primary' ? '主模型' : TIER_LABEL[step.tier]}没答上来，改用${TIER_LABEL[next.tier] || next.tier}…`);
      fireAttempt();
      return;
    }
    finishLocally(why);
    return;
  }

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
    // 不用 bubble.say：这个插件没有（也不需要）pet.bubble 权限，那次调用会被闸门拒绝，
    // 结果是"失败了但界面上什么都没有"。输入条自己的状态行就够——它就长在宠物脚下。
    setStatus('对话失败：' + why);
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

/**
 * 测试接缝：兜底链的**决策**是纯函数，单独可测；DOM 与流式接线靠 plugin-check 与预览器验。
 *
 * 只有决策函数，没有能改状态的入口——这不是一条额外的能力通道。
 */
window.__chat = Object.freeze({
  buildAttemptChain,
  classifyFailure,
  TIER_LABEL,
});