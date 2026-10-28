import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the sample plugin's app.js, driven through the real
// panel.html markup in jsdom.
//
// They run the actual bridge protocol of plugin-system design.md 9.2 against a
// fake host: `parent` in jsdom IS the window, so a spy on window.postMessage is
// the host's inbox, and a dispatched MessageEvent with source=window is a frame
// the host sent. That covers the two things the M4 criteria care about and that
// reading the source cannot: that no request precedes `init`, and that the
// granted set decides which controls come up enabled.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-chat');
const appPath = path.join(pluginDir, 'app.js');
const panelPath = path.join(pluginDir, 'panel.html');
const cssPath = path.join(pluginDir, 'style.css');

const html = readFileSync(panelPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');

// The `hidden` attribute must beat any `display` this stylesheet sets.
//
// This is asserted against the STYLESHEET text rather than by rendering, because
// the failure it guards against is invisible to every other kind of test: the
// browser's `[hidden] { display: none }` lives in the user-agent sheet, so an
// author rule that sets `display` outranks it and the element stays on screen.
// The dot-trail layer that used to sit over the conversation was
// `position: absolute; inset: 0; display: flex` and was marked `hidden` in the
// panel view, so without this rule it became a full-size INVISIBLE layer over
// the whole conversation - the interface looked perfect and every click landed
// on that layer, leaving the panel apparently dead.
//
// The dot layer is gone, but `#reply` still relies on the same rule: it is
// `display: flex` here and `hidden` in the input-bar view. A jsdom test cannot
// catch the bug either, since jsdom does not apply a stylesheet to hit-testing.
// So the rule is pinned here, next to the markup that relies on it.
describe('style.css: the hidden attribute is authoritative', () => {
  test('a [hidden] rule exists and uses !important', () => {
    const match = css.match(/\[hidden\][^{]*\{([^}]*)\}/);
    expect(match, 'style.css has no [hidden] rule').toBeTruthy();
    expect(match[1]).toMatch(/display\s*:\s*none/);
    // Without !important the rule loses to the element's own `display`, which is
    // exactly the bug: .reply is `display: flex` and #reply is `hidden`.
    expect(match[1]).toMatch(/!important/);
  });

  test('the reply list is the element that makes the [hidden] rule load-bearing', () => {
    // `app.js` toggles `hidden` on `#reply`, so it is the element at risk if it
    // also carries a `display` here. It does - the message list is a flex
    // column - which is precisely why the rule above has to exist.
    const reply = css.match(/\.reply\s*\{([^}]*)\}/s);
    expect(reply, '.reply rule is gone; re-check what this test is guarding').toBeTruthy();
    expect(reply[1]).toMatch(/display\s*:\s*flex/);
  });

  test('the dot-trail layer that caused the bug is gone', () => {
    // The three thinking ellipses were removed, and the invisible overlay went
    // with them. If a future edit brings the layer back, this test says so
    // rather than letting the comment above describe a shape that no longer
    // exists.
    expect(css).not.toMatch(/\.dots\s*\{/);
    expect(html).not.toMatch(/id="dots"/);
  });
});

let windowListeners = [];

function installPanel() {
  // innerHTML deliberately: script elements inserted that way never execute, so
  // this mounts the plugin's real markup without booting a second copy of app.js.
  //
  // The BODY's class is copied too. In a real frame `#root` IS the document's body, so
  // the appearance class persists on it - and this harness reuses one body for the whole
  // file, which would otherwise leak `view-input` from one test into the next one's
  // "nothing is painted before init" assertion.
  const parsed = new JSDOM(html);
  document.body.className = parsed.window.document.body.className;
  document.body.innerHTML = parsed.window.document.body.innerHTML;
}

async function loadApp() {
  vi.resetModules();
  await import(appPath);
}

/** Every message app.js has posted to the host so far. */
function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

/** Dispatch a frame from the host (source === window === parent in jsdom). */
function hostSends(data, { source = window } = {}) {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

function initFrame(granted) {
  return {
    v: 1,
    type: 'init',
    pluginId: 'com.shixiansi.plugin-chat',
    permissions: ['llm.chat', 'pet.surface', 'plugin.config', 'storage'],
    granted,
    surface: { kind: 'panel' },
  };
}

/**
 * An init frame for one floating block, as the host sends it (design §4.4).
 *
 * `room` is the band above the pet, which the HOST measures and the plugin cannot: it is 160px at
 * the default 桌宠大小 and 110px at 1.5x, and the answer box's ceiling is derived from it.
 */
function surfaceFrame(rectIndex, { room = 160 } = {}) {
  return {
    v: 1,
    type: 'init',
    pluginId: 'com.shixiansi.plugin-chat',
    permissions: ['llm.chat', 'pet.surface', 'plugin.config', 'storage'],
    granted: ['llm.chat', 'pet.surface', 'storage'],
    surface: {
      kind: 'surface',
      rectIndex,
      rectCount: 3,
      rect: { x: 0, y: 100, w: 308, h: 60, r: 16, tailX: 154, hidden: false, room },
    },
  };
}

/** The root element whose class names the appearance is written on. */
function shape() {
  const root = document.getElementById('root') || document.body;
  return root.className;
}

/**
 * The llm.chat request this frame posted.
 *
 * Nothing may assume it is request index 0: sending writes the question to storage
 * FIRST when the storage permission was granted, so the order depends on the grants.
 */
function chatRequest() {
  return byType('request').find((r) => r.method === 'llm.chat');
}

/** The text of every line currently in the message list. */
function msgTexts() {
  return [...document.querySelectorAll('#reply .msg')].map((el) => el.textContent);
}

/** The single line of the question box. */
function questionText() {
  return msgTexts().join('');
}

/** The single line of the answer box (the answer box shows one line element). */
function answerText() {
  return msgTexts().join('');
}

/** Answers the LAST storage.get the frame posted with the given transcript. */
function answerHistory(stored) {
  // The LAST one, not the first: a box may read more than once across a test (the
  // question box re-reads for each exchange), and answering an already-answered id would
  // leave the newest read pending forever.
  const req = byType('request').filter((r) => r.method === 'storage.get').pop();
  expect(req, 'the frame never asked for the transcript').toBeTruthy();
  hostSends({
    v: 1, type: 'response', id: req.id, ok: true,
    result: { value: JSON.stringify(stored) },
  });
}

/** Drive the plugin through a granted handshake and return the send button. */
async function handshake(granted = ['llm.chat', 'pet.surface']) {
  hostSends(initFrame(granted));
  await Promise.resolve();
}

beforeEach(() => {
  installPanel();
  windowListeners = [];
  const originalAdd = window.addEventListener.bind(window);
  // Capture window-level listeners so each test starts with a clean window: the
  // module registry is reset between tests, but listeners live on the window.
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const [type, fn, opts] of windowListeners) {
    window.removeEventListener(type, fn, opts);
  }
  windowListeners = [];
  vi.restoreAllMocks();
});

describe('handshake', () => {
  test('sends exactly one ready frame on load and nothing else', async () => {
    await loadApp();

    expect(byType('ready')).toHaveLength(1);
    expect(byType('ready')[0]).toEqual({ v: 1, type: 'ready' });
    expect(byType('request')).toHaveLength(0);
  });

  test('sends no request before init even if send is clicked', async () => {
    await loadApp();

    document.getElementById('send').click();
    document.getElementById('stop').click();

    expect(byType('request')).toHaveLength(0);
  });

  test('ignores frames that are not version 1 and frames from a foreign source', async () => {
    await loadApp();

    hostSends({ v: 2, type: 'init', granted: ['llm.chat'] });

    // The foreign frame grants everything *deliberately*: an empty-grant frame
    // would leave the UI disabled for the wrong reason, and the test would
    // still pass with the source check deleted. Only a frame that would
    // otherwise unlock the panel can prove the check is doing the work.
    const foreign = new JSDOM('<!doctype html><html><body></body></html>').window;
    expect(foreign).not.toBe(window);
    hostSends(initFrame(['llm.chat', 'pet.surface']), { source: foreign });

    // Neither frame was treated as the host's init: the input stays disabled.
    expect(document.getElementById('prompt').disabled).toBe(true);
    expect(document.getElementById('bubble')).toBeNull();
    expect(byType('request')).toHaveLength(0);
  });

  test('refuses requests before init even if a control is made clickable', async () => {
    await loadApp();

    // Strip the disabled attribute and fire the handlers directly, so the only
    // thing left standing between the click and the wire is request()'s own
    // "not initialised yet" guard. This is what pins that guard: the handler
    // must not be relying on the DOM attribute the host handed it.
    for (const id of ['surface']) {
      const el = document.getElementById(id);
      el.disabled = false;
      el.click();
    }

    expect(byType('request')).toHaveLength(0);
  });
});

describe('surface kinds', () => {
  // The same entry file serves the conversation slot and each floating block,
  // so `surface.kind` and `surface.rectIndex` are what decide the appearance.
  // These are behaviour tests rather than source greps: the class has to be on
  // the root element the stylesheet keys off.
  test('the panel kind renders the conversation view with a message list and an input', async () => {
    await loadApp();
    hostSends(initFrame(['llm.chat']));

    expect(shape()).toContain('view-panel');
    expect(document.getElementById('reply')).not.toBeNull();
    expect(document.getElementById('prompt')).not.toBeNull();
    expect(document.getElementById('prompt').disabled).toBe(false);
    // The panel's message list must be VISIBLE. jsdom does not apply the
    // stylesheet, so this asserts the `hidden` property - which is what decides
    // it - rather than computed layout. Writing the rule as "hidden unless the
    // shape is the card" hid the whole 对话 tab's transcript behind a box nobody
    // could see, and no other test noticed.
    expect(document.getElementById('reply').hidden).toBe(false);
  });

  test('the two boxes above the pet show the list, the pill under it hides it', async () => {
    // block 0 question, block 1 answer, block 2 input. The list is the question box's
    // line, the answer box's line, and nothing at all in the pill - a line drawn there
    // would be a node nobody can ever see.
    for (const [index, wantHidden] of [[0, false], [1, false], [2, true]]) {
      installPanel();
      await loadApp();
      hostSends(surfaceFrame(index));
      expect(document.getElementById('reply').hidden, `block ${index}`).toBe(wantHidden);
    }
  });

  test('each floating box gets its own root class, and none of them is a panel', async () => {
    const seen = [];
    for (const index of [0, 1, 2]) {
      installPanel();
      await loadApp();
      hostSends(surfaceFrame(index));
      seen.push(shape());
      // The transcript element is always in the document; whether it is SHOWN is what
      // the shape decides.
      expect(document.getElementById('reply')).not.toBeNull();
    }

    expect(seen).toEqual(['view-question', 'view-answer', 'view-input']);
  });

  test('the answer box focuses nothing and the input pill focuses its field', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    expect(document.activeElement).not.toBe(document.getElementById('prompt'));

    installPanel();
    await loadApp();
    hostSends(surfaceFrame(2));
    expect(document.activeElement).toBe(document.getElementById('prompt'));
  });

  test('nothing is painted before the handshake says which box this is', async () => {
    // The root class is `view-boot` until `init` arrives: the frames are already at
    // their final size when the document loads, so a default of `view-panel` painted a
    // miniature conversation panel inside every floating box for the length of the
    // handshake. jsdom does not apply the stylesheet, so this pins the class.
    await loadApp();
    expect(shape()).toContain('view-boot');
    expect(byType('request')).toHaveLength(0);
  });

  test('the three boxes are declared around the pet and fit the space it leaves', () => {
    // The geometry is the MANIFEST's, not this file's - so the assertion is against the
    // declaration the host crops the window to.
    //
    // The layout: the pet (150x200) is vertically centred in a 520px-tall window, so
    // there are ~160px above it and ~160px below. The question box and the answer box
    // share the space above; the composer pill sits under the pet's feet and, being the
    // box that does NOT point at the pet, has no tail.
    const manifest = JSON.parse(
      readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'),
    );
    const rects = manifest.surface;
    expect(rects).toHaveLength(3);

    const [question, answer, input] = rects;

    // The box that points at the pet is the ANSWER, and its DECLARED bottom edge lands EXACTLY on
    // the pet's top edge (dy + h = 0): that is where the tail's apex is. The declared height is a
    // FLOOR - the plugin asks for a taller block as the answer grows (see the height tests), and
    // the host grows it upwards, keeping that bottom edge where it is.
    expect(answer.dy + answer.h).toBe(0);
    expect(answer.h).toBe(60); // two lines + the tail and shadow bands
    expect(answer.maxH).toBeGreaterThan(answer.h);

    // The question clears the answer at the answer's FLOOR.
    expect(question.dy).toBeLessThan(answer.dy);
    expect(question.dy + question.h).toBeLessThanOrEqual(answer.dy);

    // The input pill is BELOW the pet, and it is anchored to the pet's FEET (dy is measured from
    // the pet's bottom edge, not its top): `dy: 204` was right for the default 200-tall pet and put
    // the composer on the pet's legs at 1.5x, where the pet is 300 tall.
    expect(input.anchor).toBe('bottom');
    expect(input.dy).toBe(4);
    expect(input.h).toBe(64);

    // THE BUDGET. Everything above the pet has to fit in the 160px the window has there, with the
    // answer at its CEILING (the question box is hidden by then, which is what makes the ceiling
    // reachable at all) and with it simply visible at the floor.
    const petY = 160;
    const band = -petY; // the top of the window, in pet-relative coordinates
    expect(question.dy).toBeGreaterThanOrEqual(band);
    // the tallest the answer may ask for still leaves its top inside the window
    expect(answer.dy + answer.h - answer.maxH).toBeGreaterThanOrEqual(band);
    // ...and the question box sits above the answer at the FLOOR, not overlapping it
    expect(question.dy + question.h).toBeLessThanOrEqual(answer.dy);

    // Only the answer may grow: the other two blocks declare no ceiling, so a size request for
    // them is ignored by the host rather than silently resizing the question strip or the pill.
    expect(question.maxH).toBeUndefined();
    expect(input.maxH).toBeUndefined();

    // All three are CENTRED ON THE PET, and the answer and the input are 8px wider than the bubble
    // they draw: that 4px band on each side is where the drop shadow lands (a shadow painted
    // outside the block would be cut away by the window region). The question's white edge is an
    // inset ring instead, so its block is exactly its bubble.
    const petW = 150;
    for (const r of rects) {
      expect(r.dx + r.w / 2).toBe(petW / 2);
      expect(r.ellipse).toBeUndefined();
    }
    expect(answer.w - 8).toBe(300);
    expect(input.w - 8).toBe(300);
    expect(question.w).toBe(300);
  });

  test('the build marker in app.js matches the manifest version', () => {
    // Two places have to agree or "did the frame even reload?" has no answer: the
    // placeholder shows BUILD, while the host decides to rebuild the frame on VERSION.
    const manifest = JSON.parse(
      readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'),
    );
    const src = readFileSync(appPath, 'utf8');
    const build = src.match(/const BUILD = '([^']+)'/);
    expect(build, 'app.js has no BUILD constant').toBeTruthy();
    expect(build[1]).toBe(manifest.version);
  });

  test('the manifest declares no ellipse block any more', () => {
    // The three thinking puffs were removed. `ellipse: true` is still a
    // supported manifest feature, but this plugin no longer uses it - and a
    // stray one would be cropped to an ellipse nothing draws into.
    const manifest = JSON.parse(
      readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'),
    );
    expect(manifest.surface.some((r) => r.ellipse === true)).toBe(false);
  });
});

describe('removed affordances', () => {
  // Two pieces of text were removed from the plugin's own interface, and both
  // are asserted here so a future edit cannot quietly bring them back.
  test('the panel has no hint line and no composer placeholder', () => {
    expect(html).not.toMatch(/id="hint"/);
    expect(html).not.toMatch(/双击桌宠/);
    expect(html).not.toMatch(/和大模型说点什么/);
    // The textarea is still there - only its prompt text is gone.
    expect(html).toMatch(/id="prompt"/);
  });

  test('the panel renders without a hint element', async () => {
    await loadApp();
    hostSends(initFrame(['llm.chat']));
    expect(document.getElementById('hint')).toBeNull();
  });

  test('the send button is an icon, not the word 发送', () => {
    // It has to keep an accessible name, so the aria-label is what a screen
    // reader announces; the visible content is an inline SVG (a fetched icon
    // could not load inside the sandbox).
    const send = html.match(/<button id="send"[\s\S]*?<\/button>/);
    expect(send, 'the send button is gone').toBeTruthy();
    expect(send[0]).toContain('aria-label="发送"');
    expect(send[0]).toContain('<svg');
    expect(send[0]).not.toMatch(/>发送</);
  });

  // The transcript is the SAME array in both views; what differs is how much of
  // it each one draws. These are two tests rather than two phases of one,
  // because each phase needs its own module instance and its own window
  // listeners - running both in one test leaves the first module subscribed, and
  // the second phase's response then has two listeners racing for it.
  const storedTurns = [
    { role: 'user', text: '第一问' },
    { role: 'assistant', text: '第一答' },
    { role: 'user', text: '第二问' },
    { role: 'assistant', text: '第二答' },
  ];

  /** Answer the frame's storage.get with the stored transcript. */
  function replyWithHistory(stored) {
    answerHistory(stored);
  }

  test('the panel shows the whole transcript, questions included', async () => {
    installPanel();
    await loadApp();
    hostSends(initFrame(['llm.chat', 'storage']));
    replyWithHistory(storedTurns);

    const lines = [...document.querySelectorAll('#reply .msg')].map((el) => el.textContent);
    expect(lines).toEqual(['第一问', '第一答', '第二问', '第二答']);
  });

  test('the answer box shows only the latest reply, never the questions', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    replyWithHistory(storedTurns);

    const lines = [...document.querySelectorAll('#reply .msg')].map((el) => el.textContent);
    expect(lines).toEqual(['第二答']);
  });

  test('the question box stays empty until an exchange starts', async () => {
    // Open time is not an exchange: the question box is HIDDEN then (the host is told so in the
    // same breath), so rendering into it would only leave the last question behind for the next
    // exchange to flash up before its own text arrives.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(0));
    replyWithHistory(storedTurns);

    // The transcript WAS read (the frame needs `hasAnswer` to decide whether the answer box is
    // worth showing), it just is not drawn.
    expect(msgTexts()).toEqual([]);
  });

  test('the question box shows the question of the running exchange', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(0));
    replyWithHistory(storedTurns.map((t) => ({ ...t, text: t.text })));

    // The first chunk of an exchange is its start: read the transcript again and draw the
    // newest question.
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r-question', text: 'x' } });
    replyWithHistory([...storedTurns, { role: 'user', text: '这一次问的' }]);

    expect(msgTexts()).toEqual(['这一次问的']);
  });

  test('the answer box keeps showing the last answer while a new question is in flight', async () => {
    // The newest entry is then the USER's. The answer box must not put the question up as
    // if it were the answer - that is the question box's job, one block higher.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    replyWithHistory([
      { role: 'assistant', text: '旧答案' },
      { role: 'user', text: '新问题' },
    ]);

    const lines = [...document.querySelectorAll('#reply .msg')].map((el) => el.textContent);
    expect(lines).toEqual(['旧答案']);
  });

  test('the input pill draws neither the question nor the answer', async () => {
    // It has no visible list, so a line appended there is invisible - but it would still
    // be a node in the document, and the 1.5.x pill turned itself into a RESULT area
    // (`#result`) and typed the answer into it. That mode is gone with the fixed boxes.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(2));
    replyWithHistory(storedTurns);

    expect(document.querySelectorAll('#reply .msg')).toHaveLength(0);
    expect(document.getElementById('result')).toBeNull();
    expect(html).not.toMatch(/id="result"/);
  });
});

describe('the answer box streams a reply it did not ask for', () => {
  // Only ONE frame sends the request - the one the user typed into (the panel, or the
  // input pill under the pet). The answer box watches the same events, so it builds a
  // display holder on the first delta rather than dropping every chunk.
  //
  // This is also what removes the round trip the 1.5.x reply card needed: that card drew
  // whatever the TRANSCRIPT ended with, so it had to poll storage every 800ms to notice
  // that the answer had arrived - and until a poll landed it showed the QUESTION. The
  // answer box owns its display, so `llm.done` is the end of the story.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a watched reply is rendered from its deltas, one character at a time', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r1', text: '你' } });
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r1', text: '好' } });

    // 1 char / 50ms is the reveal rate, so nothing is on screen until the timer ticks.
    const line = document.querySelector('#reply .msg.assistant');
    expect(line.textContent).toBe('');
    vi.advanceTimersByTime(100);
    expect(line.textContent).toBe('你好');
  });

  test('a reply that opens with blank lines is drawn from its first real line', async () => {
    // Models open with "\n\n". With `white-space: pre-wrap` those are REAL empty lines: two of
    // them pushed the text a third of the way down the 90px bubble (measured on the real window:
    // 40 blank pixels above the first line), which reads as "empty box with text at the bottom".
    vi.useFakeTimers();
    try {
      installPanel();
      await loadApp();
      hostSends(surfaceFrame(1));

      hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r1', text: '\n\n就是' } });
      hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId: 'r1', text: '\n\n就是字面意思' } });
      vi.advanceTimersByTime(2000);

      // The blank lines are gone, and the paragraph break INSIDE the reply is untouched.
      expect(answerText()).toBe('就是字面意思');
    } finally {
      vi.useRealTimers();
    }
  });

  test('the stored answer has no leading or trailing blank lines either', async () => {
    await loadApp();
    await handshake(['llm.chat', 'storage']);
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = chatRequest().payload;

    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '\n\n喵\n' } });

    const writes = byType('request').filter((r) => r.method === 'storage.set');
    const stored = JSON.parse(writes[writes.length - 1].payload.value).map((m) => m.text);
    expect(stored).toEqual(['你好', '喵']);
  });

  test('a new exchange replaces the previous answer on its first delta', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    answerHistory([{ role: 'assistant', text: '上一条回答' }]);
    expect(answerText()).toBe('上一条回答');

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r2', text: '新' } });
    vi.advanceTimersByTime(50);

    // One answer at a time: the old one gives way instead of sitting above the new one.
    expect(document.querySelectorAll('#reply .msg')).toHaveLength(1);
    expect(answerText()).toBe('新');
  });

  test('llm.done snaps to the authoritative text after the queue drains', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r3', text: '半' } });
    // `done` carries the whole answer and disagrees: a chunk was lost in flight.
    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId: 'r3', text: '半句话。' } });
    vi.advanceTimersByTime(200);

    // Replaced, never appended: the fragment appears exactly once.
    expect(answerText()).toBe('半句话。');
    expect(answerText().match(/半/g)).toHaveLength(1);
  });

  test('a watching frame never writes the transcript', async () => {
    // Every frame receives the llm.* events, so a frame that merely watched the
    // reply must not `remember` it - that is what would store one copy of the
    // same answer per visible block.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r1', text: '你好' } });
    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId: 'r1', text: '你好' } });

    expect(byType('request').filter((r) => r.method === 'storage.set')).toHaveLength(0);
  });

  test('the owning frame writes the answer exactly once', async () => {
    await loadApp();
    await handshake(['llm.chat', 'storage']);
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = chatRequest().payload;

    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '喵' } });

    // A turn saves twice by design - once for the question, once for the answer - so the
    // assertion is not "one write" but "the ANSWER appears in exactly one of them". That
    // is the property `ownRequestId` exists to keep: without it, every visible frame of
    // the plugin would write its own copy.
    const writes = byType('request').filter((r) => r.method === 'storage.set');
    const withAnswer = writes.filter((w) =>
      JSON.parse(w.payload.value).some((m) => m.text === '喵'));
    expect(withAnswer).toHaveLength(1);
    expect(JSON.parse(withAnswer[0].payload.value).map((m) => m.text)).toEqual(['你好', '喵']);
  });

  test('an answer that arrives only in llm.done is still stored', async () => {
    // The 1.5.x owner deferred the transcript write to the end of the typewriter, and the
    // typewriter only ever started on a delta. A reply delivered in one piece therefore
    // set a callback that nothing would ever call: the answer was displayed and never
    // saved. The write happens on `done` now, so this is a non-streaming answer's path.
    await loadApp();
    await handshake(['llm.chat', 'storage']);
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = chatRequest().payload;

    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '一次给全' } });

    const writes = byType('request').filter((r) => r.method === 'storage.set');
    const stored = JSON.parse(writes[writes.length - 1].payload.value).map((m) => m.text);
    expect(stored).toEqual(['你好', '一次给全']);
  });

  test('a delta arriving after stop does not rebuild the line', async () => {
    // `onDelta` used to drop a chunk whenever no holder existed, which is how
    // stop worked. Adopting a late chunk would resurrect the abandoned reply.
    await loadApp();
    await handshake();
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = chatRequest().payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '之一' } });
    document.getElementById('stop').click();
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '之二' } });

    expect(document.querySelectorAll('#reply .msg.assistant')).toHaveLength(1);
    expect(document.querySelector('#reply .msg.assistant').textContent).toBe('之一');
  });
});

describe('the visibility flow: only the composer, then the question, then no question', () => {
  // `surface.blocks` carries the WHOLE hidden set, so the only arrangement that works with
  // three documents is that every caller computes the same set from the same facts. These
  // tests pin the three states and the transitions between them:
  //
  //   idle, nothing to read      block 0 and 1 hidden   (one composer under the pet)
  //   idle, an answer to read    block 0 hidden         (the answer stays, the question is gone)
  //   asking                     nothing hidden         (question on top, answer streaming)
  const hiddenSets = () =>
    byType('request')
      .filter((r) => r.method === 'surface.blocks')
      .map((r) => r.payload.hidden);

  test('a surface with no transcript opens as just the composer', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    answerHistory([]);

    expect(hiddenSets()).toEqual([[0, 1]]);
  });

  test('reopening after a conversation keeps the answer and drops the question', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    answerHistory([
      { role: 'user', text: '问' },
      { role: 'assistant', text: '答' },
    ]);

    // Only block 0: the question belongs to an exchange that is over, and the answer box has
    // last turn's reply to show. (The answer box is the only frame that asks - see the height
    // tests below for why.)
    expect(hiddenSets()).toEqual([[0]]);
  });

  test('the question box itself never asks', async () => {
    // `surface.blocks` replaces the WHOLE size map, and the question box has no idea how tall the
    // answer is - so a call from this frame would reset the answer to its floor.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(0));
    answerHistory([{ role: 'user', text: '问' }]);

    expect(hiddenSets()).toEqual([]);
  });

  test('a question with no answer yet leaves only the composer too', async () => {
    // The transcript ends with the user's turn - the state after a crash mid-answer.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    answerHistory([{ role: 'user', text: '问' }]);

    expect(hiddenSets()).toEqual([[0, 1]]);
  });

  test('the question stays up until the answer has finished being TYPED OUT', async () => {
    // `llm.done` ends the request; the typewriter runs at 1 char / 50ms, so the question must
    // survive until the last character is on screen - and then ONE MORE SECOND (the user's
    // call), so the turn reads as a question/answer pair instead of flickering.
    vi.useFakeTimers();
    try {
      installPanel();
      await loadApp();
      hostSends(surfaceFrame(1));
      answerHistory([{ role: 'user', text: '问' }]);

      hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r7', text: 'a' } });
      hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r7', text: 'b' } });
      hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId: 'r7', text: 'ab' } });

      // Start → everything visible. `done` with two characters still queued → still nothing
      // hidden, because the answer is not fully on screen yet.
      expect(hiddenSets()).toEqual([[0, 1], []]);

      vi.advanceTimersByTime(50); // one character on screen, one still queued
      expect(hiddenSets()).toEqual([[0, 1], []]);

      vi.advanceTimersByTime(50); // queue drained: the one-second grace period starts
      expect(hiddenSets()).toEqual([[0, 1], []]);

      vi.advanceTimersByTime(1000); // ...and only then does the question go
      expect(hiddenSets()).toEqual([[0, 1], [], [0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an answer that arrives with nothing to type never brings the question up', async () => {
    vi.useFakeTimers();
    try {
      installPanel();
      await loadApp();
      hostSends(surfaceFrame(1));
      answerHistory([{ role: 'user', text: '问' }]);

      // No chunk at all: `asking` never becomes true, so the question box never came up and there
      // is nothing to wait a second for. `done` carries the whole answer and puts it on screen.
      hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId: 'r9', text: '一次给全' } });
      expect(hiddenSets()).toEqual([[0, 1], [0]]);

      // Nothing further: the state is already settled, and no timer is left to fire.
      vi.advanceTimersByTime(2000);
      expect(hiddenSets()).toEqual([[0, 1], [0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a new question inside the grace period keeps its own question box', async () => {
    // The pending "the last exchange is over" timer must not take down the question box of the
    // exchange that has just started.
    vi.useFakeTimers();
    try {
      installPanel();
      await loadApp();
      hostSends(surfaceFrame(1));
      answerHistory([{ role: 'user', text: '问' }]);

      hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r1', text: '答' } });
      hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId: 'r1', text: '答' } });
      vi.advanceTimersByTime(100); // the character is typed out, so the grace period starts

      // ...and inside that second, a new exchange starts
      hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r2', text: 'x' } });
      vi.advanceTimersByTime(2000);

      // Never `[0]` after the `[]`: the r1 timer was cancelled by r2.
      expect(hiddenSets()).toEqual([[0, 1], []]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an error also ends the exchange, and keeps the box that shows the failure', async () => {
    vi.useFakeTimers();
    try {
      installPanel();
      await loadApp();
      hostSends(surfaceFrame(1));
      answerHistory([]);

      // An error before any chunk: there is no exchange in flight as far as the boxes are
      // concerned, so the question box is hidden at once - and it is `[0]`, not `[0,1]`, because
      // the answer box is showing the error and hiding it would hide the only explanation.
      hostSends({
        v: 1,
        type: 'event',
        name: 'llm.error',
        payload: { requestId: 'r8', message: '宿主未配置大模型' },
      });

      expect(hiddenSets()).toEqual([[0, 1], [0]]);
      vi.advanceTimersByTime(2000);
      expect(hiddenSets()).toEqual([[0, 1], [0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the composer leaves visibility alone: the boxes come up with the first chunk', async () => {
    // Showing the question box at send time would flash whatever that box still holds - the
    // PREVIOUS question - because the composer is a different document and cannot draw into it;
    // the box only learns its new text one storage read later. So the composer asks for nothing,
    // and both content boxes come up together when the first chunk arrives.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(2));

    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();

    expect(hiddenSets()).toEqual([]);
  });

  test('the panel never asks: no surface is open when it sends', async () => {
    // `surface.blocks` is refused when no surface is open, and the refusal would come back as
    // an error line in the transcript - so the panel must not call it at all.
    await loadApp();
    await handshake(['llm.chat', 'pet.surface']);
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();

    expect(hiddenSets()).toEqual([]);
  });
});

describe('the answer box fits its text instead of a fixed height', () => {
  // The box is declared at its FLOOR (56, two lines) and asks the host for the height it needs, up
  // to 152 (the whole band above the pet). Clipping a 4-line answer was the user's complaint; the
  // ceiling is arithmetic - 160px above the pet, minus an 8px margin.
  //
  // jsdom does not lay out, so every measurement is stubbed onto the rendered line.
  const asks = () => byType('request').filter((r) => r.method === 'surface.blocks');
  const lastAsk = () => asks().pop();

  function stubTextHeight(px) {
    const line = document.querySelector('#reply .msg');
    expect(line, 'nothing was rendered, so there is no height to fake').toBeTruthy();
    line.getBoundingClientRect = () => ({
      height: px, width: 280, top: 0, left: 0, right: 280, bottom: px, x: 0, y: 0,
    });
  }

  /** Drives one chunk with a given text height, and returns the last ask. */
  async function chunk(heightPx) {
    // The line element only exists once a chunk has started the holder, and the height is measured
    // in the typewriter's tick (every 4th 50ms), so: chunk, tick, stub, chunk, tick.
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'rx', text: '字' } });
    vi.advanceTimersByTime(250);
    stubTextHeight(heightPx);
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'rx', text: '字' } });
    vi.advanceTimersByTime(250);
    return lastAsk();
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a short answer asks for the declared floor, and both boxes stay up', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    answerHistory([{ role: 'user', text: '问' }]);

    const ask = await chunk(34); // two lines
    expect(ask.payload.sizes).toEqual({ 1: 60 });
    expect(ask.payload.hidden).toEqual([]);
  });

  test('a taller answer asks for exactly what it needs', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    answerHistory([{ role: 'user', text: '问' }]);

    // 72px of text + 24px of chrome (tail + shadow bands) = 96, still under the 100 the question box leaves.
    const ask = await chunk(72);
    expect(ask.payload.sizes).toEqual({ 1: 96 });
    expect(ask.payload.hidden).toEqual([]);
  });

  test('an answer taller than the band takes the ceiling and evicts the question', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    answerHistory([{ role: 'user', text: '问' }]);

    // 200 + 24 clamps to 156, which no longer fits under the question box: the question is the
    // thing that gives way, because the answer is what the user is reading.
    const ask = await chunk(200);
    expect(ask.payload.sizes).toEqual({ 1: 156 });
    expect(ask.payload.hidden).toEqual([0]);
  });

  test('it never asks for more than the band above the pet', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    answerHistory([{ role: 'user', text: '问' }]);

    const ask = await chunk(4000);
    expect(ask.payload.sizes[1]).toBe(156);
  });

  test('a bigger pet leaves less band, so the answer asks for less', async () => {
    // The user's 1.5x pet: the pet is 300 tall and centred, so only 110px of band is left above it.
    // Asking for the manifest's 156 would be requesting something the window cannot hold - which is
    // exactly what cut the top off the bubble before the host started reporting `room`.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1, { room: 110 }));
    answerHistory([{ role: 'user', text: '问' }]);

    const ask = await chunk(4000);
    expect(ask.payload.sizes[1]).toBe(106); // 110 - the 4px margin
    expect(ask.payload.hidden).toEqual([0]); // and no room left for the question strip
  });

  test('a two-line answer still leaves room for the question strip on a big pet', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1, { room: 110 }));
    answerHistory([{ role: 'user', text: '问' }]);

    // 34px of text + 24 of chrome = 58, clamped up to the 60 floor; 60 + 48 of question strip = 108,
    // just inside 110.
    const ask = await chunk(34);
    expect(ask.payload.sizes).toEqual({ 1: 60 });
    expect(ask.payload.hidden).toEqual([]);
  });

  test('a resize from the host makes it re-ask, even for the same height', async () => {
    // A resize is the only signal this document gets when the host changes the block under it: the
    // frames are REUSED across a re-open of the surface (no second `init`), and a re-open restarts
    // the host from the manifest's defaults - an empty question strip and an answer box at its
    // floor. Re-asking is what repairs that, so the "nothing changed" guard must not swallow it.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    answerHistory([{ role: 'assistant', text: '上一条回答' }]);
    const before = asks().length;

    // The text is taller than the floor, which is exactly what the reset lost.
    stubTextHeight(72);
    window.dispatchEvent(new Event('resize'));

    expect(asks().length).toBe(before + 1);
    expect(lastAsk().payload.sizes).toEqual({ 1: 96 });
    expect(lastAsk().payload.hidden).toEqual([0]);
  });
});

describe('the question box follows the exchange', () => {
  test('it reads the transcript once per exchange, not per delta', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(0));
    answerHistory([
      { role: 'user', text: '旧问题' },
      { role: 'assistant', text: '旧答案' },
    ]);
    // Nothing is drawn yet: open time belongs to no exchange (see the test above).
    expect(questionText()).toBe('');

    const reads = () => byType('request').filter((r) => r.method === 'storage.get').length;
    const before = reads();

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r9', text: 'a' } });
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r9', text: 'b' } });
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r9', text: 'c' } });

    // Three deltas, one read: the box is not a poll. (The 1.5.x card polled every 800ms for up
    // to 48 seconds to find out whether the answer had been stored yet.)
    expect(reads()).toBe(before + 1);

    answerHistory([
      { role: 'user', text: '旧问题' },
      { role: 'assistant', text: '旧答案' },
      { role: 'user', text: '新问题' },
    ]);
    expect(questionText()).toBe('新问题');

    // A further delta for the SAME exchange reads nothing more.
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r9', text: 'd' } });
    expect(reads()).toBe(before + 1);
  });
});

describe('granted-driven UI', () => {
  test('enables the input and send only when llm.chat is granted', async () => {
    await loadApp();
    await handshake([]);

    const prompt = document.getElementById('prompt');
    expect(prompt.disabled).toBe(true);
    expect(document.getElementById('send').disabled).toBe(true);
    expect(document.getElementById('status').textContent).toContain('未获授权：llm.chat');
  });

  test('enables the input and send when llm.chat is granted', async () => {
    await loadApp();
    await handshake(['llm.chat']);

    expect(document.getElementById('prompt').disabled).toBe(false);
    expect(document.getElementById('send').disabled).toBe(false);
    expect(document.getElementById('status').textContent).not.toContain('未获授权：llm.chat');
  });

  test('disables the bubble button without pet.bubble and the surface button without pet.surface', async () => {
    await loadApp();
    await handshake(['llm.chat']);

    expect(document.getElementById('bubble')).toBeNull();
    expect(document.getElementById('surface').disabled).toBe(true);
  });

  test('enables the bubble and surface buttons when granted', async () => {
    await loadApp();
    await handshake();

    expect(document.getElementById('bubble')).toBeNull();
    expect(document.getElementById('surface').disabled).toBe(false);
  });
});

describe('llm.chat', () => {
  async function ask(text = '你好') {
    await loadApp();
    await handshake();
    const prompt = document.getElementById('prompt');
    prompt.value = text;
    document.getElementById('send').click();
    // The FIRST request is not necessarily the chat one (writing the question to storage
    // comes first when it is granted), so the helper picks the chat request out by name.
    return chatRequest();
  }

  test('sends a well-formed request carrying the prompt and a requestId', async () => {
    const request = await ask('你好');

    expect(request.v).toBe(1);
    expect(request.type).toBe('request');
    expect(typeof request.id).toBe('string');
    expect(request.id.length).toBeGreaterThan(0);
    expect(request.method).toBe('llm.chat');
    expect(request.payload.text).toBe('你好');
    expect(typeof request.payload.requestId).toBe('string');
    expect(request.payload.requestId.length).toBeGreaterThan(0);
  });

  test('appends deltas into one text node that survives the whole reply', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '你' } });
    const container = document.querySelector('#reply .msg.assistant');
    const original = container.childNodes[0];
    expect(original.nodeType).toBe(3);
    expect(original.data).toBe('你');

    for (const chunk of ['好', '，', '世界']) {
      hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: chunk } });
    }

    expect(container.childNodes).toHaveLength(1);
    expect(container.childNodes[0]).toBe(original);
    expect(container.childNodes[0].data).toBe('你好，世界');
  });

  test('drops a late delta whose requestId is not the current one', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '当前' } });
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'stale-id', text: '过期' } });

    const container = document.querySelector('#reply .msg.assistant');
    expect(container.textContent).toBe('当前');
  });

  test('renders llm.error as a system line', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    hostSends({
      v: 1,
      type: 'event',
      name: 'llm.error',
      payload: { requestId, message: '宿主未配置大模型' },
    });

    const system = document.querySelector('#reply .msg.system');
    expect(system).not.toBeNull();
    expect(system.textContent).toContain('宿主未配置大模型');
  });

  test('finalises on llm.done using the authoritative full text', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '半' } });
    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '半句话。' } });

    const container = document.querySelector('#reply .msg.assistant');
    expect(container.textContent).toBe('半句话。');

    // The reply is over, so a delta that arrives now is stale and must be dropped.
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '多余' } });
    expect(container.textContent).toBe('半句话。');
  });

  test('llm.done REPLACES the accumulated text when the two disagree', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    // The deltas lost a chunk (a dropped frame, a retry that re-sent the tail),
    // so what is on screen is a fragment of the answer.
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '你好，' } });
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '世界' } });
    expect(document.querySelector('#reply .msg.assistant').textContent).toBe('你好，世界');

    hostSends({
      v: 1,
      type: 'event',
      name: 'llm.done',
      payload: { requestId, text: '你好，世界！这一句在分片里丢了。' },
    });

    const container = document.querySelector('#reply .msg.assistant');
    expect(container.textContent).toBe('你好，世界！这一句在分片里丢了。');
    // Replaced, not appended: the fragment appears exactly once.
    expect(container.textContent.match(/你好，世界/g)).toHaveLength(1);
  });

  test('llm.done keeps the streamed text when it agrees', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '一致' } });
    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '一致' } });

    expect(document.querySelector('#reply .msg.assistant').textContent).toBe('一致');
  });
});

describe('transcript storage', () => {
  // The transcript is the PLUGIN's data: the host writes llm-usage, the plugin
  // writes llm-history through its own storage capability (design §4.2). These
  // assert the round trip at the bridge level.
  test('a finished turn is written to the plugin storage under llm-history', async () => {
    await loadApp();
    await handshake(['llm.chat', 'storage']);
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = chatRequest().payload;

    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '喵' } });

    const writes = byType('request').filter((r) => r.method === 'storage.set');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0].payload.key).toBe('llm-history');
    const stored = JSON.parse(writes[writes.length - 1].payload.value);
    expect(stored.map((m) => m.text)).toContain('你好');
    expect(stored.map((m) => m.text)).toContain('喵');
  });

  test('the stored transcript is read back and rendered', async () => {
    await loadApp();
    const [readId] = (() => {
      hostSends(initFrame(['llm.chat', 'storage']));
      return byType('request').filter((r) => r.method === 'storage.get').map((r) => r.id);
    })();
    // The host answers the storage.get with what it holds.
    const stored = [{ role: 'user', text: '早上好' }, { role: 'assistant', text: '早上好呀' }];
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { v: 1, type: 'response', id: readId, ok: true, result: { value: JSON.stringify(stored) } },
        source: window,
      }),
    );

    const lines = [...document.querySelectorAll('#reply .msg')].map((el) => el.textContent);
    expect(lines).toContain('早上好');
    expect(lines).toContain('早上好呀');
  });

  test('without the storage permission nothing is written', async () => {
    await loadApp();
    await handshake(['llm.chat']);
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = byType('request')[0].payload;
    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '喵' } });

    expect(byType('request').filter((r) => r.method === 'storage.set')).toHaveLength(0);
  });
});

describe('bubble and surface', () => {
  test('the reply is never pushed into the pet bubble', async () => {
    // This used to assert that a 「气泡」 button sent the first line of the reply via `bubble.say`.
    // That button is GONE, and the assertion is inverted rather than deleted: the plugin's own answer
    // block already draws the reply above the pet, and `bubble.say` would call `showBubble`, which
    // folds the plugin surface - the button closed the window it lived in. Two things must stay true
    // now: the control is not in the document, and no code path sends `bubble.say`.
    await loadApp();
    await handshake();
    document.getElementById('prompt').value = '写点东西';
    document.getElementById('send').click();
    const request = byType('request')[0];
    const { requestId } = request.payload;

    hostSends({
      v: 1,
      type: 'event',
      name: 'llm.done',
      payload: { requestId, text: '第一行\n第二行' },
    });

    expect(document.getElementById('bubble')).toBeNull();
    expect(byType('request').filter((r) => r.method === 'bubble.say')).toHaveLength(0);
  });

  test('the surface button toggles surface.show and surface.hide', async () => {
    await loadApp();
    await handshake();
    const button = document.getElementById('surface');

    button.click();
    expect(byType('request').map((r) => r.method)).toContain('surface.show');

    button.click();
    expect(byType('request').map((r) => r.method)).toContain('surface.hide');
  });

  test('stop abandons the reply, so its later deltas are dropped', async () => {
    await loadApp();
    await handshake();
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = byType('request')[0].payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '之一' } });
    document.getElementById('stop').click();
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '之二' } });

    expect(document.querySelector('#reply .msg.assistant').textContent).toBe('之一');
  });
});

describe('capability hygiene', () => {
  test('app.js uses no fetch, no localStorage and no file APIs', () => {
    const src = readFileSync(appPath, 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\blocalStorage\b/);
    expect(src).not.toMatch(/\bsessionStorage\b/);
    expect(src).not.toMatch(/\bXMLHttpRequest\b/);
  });
});
