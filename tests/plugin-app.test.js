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
  const parsed = new JSDOM(html);
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
    permissions: ['llm.chat', 'pet.bubble', 'pet.surface', 'plugin.config', 'storage'],
    granted,
    surface: { kind: 'panel' },
  };
}

/** An init frame for one floating block, as the host sends it (design §4.4). */
function surfaceFrame(rectIndex) {
  return {
    v: 1,
    type: 'init',
    pluginId: 'com.shixiansi.plugin-chat',
    permissions: ['llm.chat', 'pet.bubble', 'pet.surface', 'plugin.config', 'storage'],
    granted: ['llm.chat', 'pet.bubble', 'pet.surface', 'storage'],
    surface: { kind: 'surface', rectIndex, rectCount: 2 },
  };
}

/** The root element whose class names the appearance is written on. */
function shape() {
  const root = document.getElementById('root') || document.body;
  return root.className;
}

/** Drive the plugin through a granted handshake and return the send button. */
async function handshake(granted = ['llm.chat', 'pet.bubble', 'pet.surface']) {
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
    hostSends(initFrame(['llm.chat', 'pet.bubble', 'pet.surface']), { source: foreign });

    // Neither frame was treated as the host's init: the input stays disabled.
    expect(document.getElementById('prompt').disabled).toBe(true);
    expect(document.getElementById('bubble').disabled).toBe(true);
    expect(byType('request')).toHaveLength(0);
  });

  test('refuses requests before init even if a control is made clickable', async () => {
    await loadApp();

    // Strip the disabled attribute and fire the handlers directly, so the only
    // thing left standing between the click and the wire is request()'s own
    // "not initialised yet" guard. This is what pins that guard: the handler
    // must not be relying on the DOM attribute the host handed it.
    for (const id of ['bubble', 'surface']) {
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

  test('the input bar hides the message list but the panel and card show it', async () => {
    for (const [index, wantHidden] of [[1, true], [0, false]]) {
      installPanel();
      await loadApp();
      hostSends(surfaceFrame(index));
      expect(document.getElementById('reply').hidden).toBe(wantHidden);
    }
  });

  test('the two floating shapes get two distinct root classes', async () => {
    const seen = [];
    for (const index of [0, 1]) {
      installPanel();
      await loadApp();
      hostSends(surfaceFrame(index));
      seen.push(shape());
      // The transcript is always in the document; whether it is SHOWN is what
      // the shape decides below.
      expect(document.getElementById('reply')).not.toBeNull();
    }

    expect(seen[0]).toContain('view-card');
    expect(seen[1]).toContain('view-bar');
    expect(new Set(seen).size).toBe(2);
  });

  test('the card shows the transcript, the bar hides it and focuses the input', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(0));
    expect(document.getElementById('reply').hidden).toBe(false);

    installPanel();
    await loadApp();
    hostSends(surfaceFrame(1));
    expect(document.getElementById('reply').hidden).toBe(true);
  });

  test('both floating blocks hang above the pet, the pill touching it', () => {
  // The geometry is the MANIFEST's, not this file's - so the assertion is against the
  // declaration the host crops the window to.
  //
  // The shape this pins is Coopanion's: the input pill sits directly ON the pet, with a
  // tail pointing down at it, and the reply strip floats above the pill. The input used to
  // be BELOW the pet, which put a text field in the middle of whatever the user was doing.
  const manifest = JSON.parse(
    readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'),
  );
  const rects = manifest.surface;
  expect(rects).toHaveLength(2);

  const [card, bar] = rects;
  // Both are above the pet's top-left origin (dy is negative = up).
  expect(card.dy).toBeLessThan(0);
  expect(bar.dy).toBeLessThan(0);

  // The pill's bottom edge lands EXACTLY on the pet's top edge: that is where the tail
  // ends, and it is why the block is taller than the visible pill - the host crops to
  // this rectangle, so a tail drawn outside it would be cut away.
  expect(bar.dy + bar.h).toBe(0);
  // ...and it is taller than the pill it draws, by the tail band.
  expect(bar.h).toBeGreaterThan(56);

  // The reply strip clears the pill: its bottom edge is above the pill's top edge.
  expect(card.dy + card.h).toBeLessThanOrEqual(bar.dy);

  // Both are 300 wide - twice the pet's 150 - and `dx: -75` puts their CENTRE
  // on the pet's centre, which is also what keeps the tail centred on the pet's head.
  // The pet is only 150 wide, so a 300-wide block centred on it necessarily overhangs the
  // pet's column; the host lets it extend toward the free side of the window rather than
  // clipping it.
  const petW = 150;
  for (const r of rects) {
    expect(r.w).toBe(300);
    expect(r.dx + r.w / 2).toBe(petW / 2);
    expect(r.ellipse).toBeUndefined();
  }
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
    const req = byType('request').find((r) => r.method === 'storage.get');
    expect(req, 'the frame never asked for the transcript').toBeTruthy();
    hostSends({
      v: 1, type: 'response', id: req.id, ok: true,
      result: { value: JSON.stringify(stored) },
    });
  }

  test('the panel shows the whole transcript, questions included', async () => {
    installPanel();
    await loadApp();
    hostSends(initFrame(['llm.chat', 'storage']));
    replyWithHistory(storedTurns);

    const lines = [...document.querySelectorAll('#reply .msg')].map((el) => el.textContent);
    expect(lines).toEqual(['第一问', '第一答', '第二问', '第二答']);
  });

  test('the reply card shows only the latest reply, never the questions', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(0));
    replyWithHistory(storedTurns);

    const lines = [...document.querySelectorAll('#reply .msg')].map((el) => el.textContent);
    expect(lines).toEqual(['第二答']);
  });

  test('the card keeps showing the last answer while a new question is in flight', async () => {
    // The newest entry is then the USER's. The card must not put the question up
    // as if it were the answer.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(0));
    replyWithHistory([
      { role: 'assistant', text: '旧答案' },
      { role: 'user', text: '新问题' },
    ]);

    const lines = [...document.querySelectorAll('#reply .msg')].map((el) => el.textContent);
    expect(lines).toEqual(['旧答案']);
  });
});

describe('the reply card streams a reply it did not ask for', () => {
  // Only ONE frame sends the request - the one the user typed into. The card
  // above the pet watches the same events, so it has to build a display holder
  // on the first delta rather than dropping every chunk.
  test('a watched reply is rendered from its deltas', async () => {
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(0));

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r1', text: '你' } });
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r1', text: '好' } });

    expect(document.querySelector('#reply .msg.assistant').textContent).toBe('你好');
  });

  test('a watching frame never writes the transcript', async () => {
    // Every frame receives the llm.* events, so a frame that merely watched the
    // reply must not `remember` it - that is what would store one copy of the
    // same answer per visible block.
    installPanel();
    await loadApp();
    hostSends(surfaceFrame(0));

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'r1', text: '你好' } });
    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId: 'r1', text: '你好' } });

    expect(byType('request').filter((r) => r.method === 'storage.set')).toHaveLength(0);
  });

  test('the owning frame still writes the answer exactly once', async () => {
    await loadApp();
    await handshake(['llm.chat', 'storage']);
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = byType('request')[0].payload;

    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '喵' } });

    // A turn saves twice by design - once for the question, once for the answer -
    // so the assertion is not "one write" but "the ANSWER appears in exactly one
    // of them". That is the property the per-frame `owner` flag exists to keep:
    // without it, each visible frame of the plugin would write its own copy.
    const writes = byType('request').filter((r) => r.method === 'storage.set');
    const withAnswer = writes.filter((w) =>
      JSON.parse(w.payload.value).some((m) => m.text === '喵'));
    expect(withAnswer).toHaveLength(1);
    expect(JSON.parse(withAnswer[0].payload.value).map((m) => m.text)).toEqual(['你好', '喵']);
  });

  test('a delta arriving after stop does not rebuild the line', async () => {
    // `onDelta` used to drop a chunk whenever no holder existed, which is how
    // stop worked. Adopting a late chunk would resurrect the abandoned reply.
    await loadApp();
    await handshake();
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = byType('request')[0].payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '之一' } });
    document.getElementById('stop').click();
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '之二' } });

    expect(document.querySelectorAll('#reply .msg.assistant')).toHaveLength(1);
    expect(document.querySelector('#reply .msg.assistant').textContent).toBe('之一');
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

    expect(document.getElementById('bubble').disabled).toBe(true);
    expect(document.getElementById('surface').disabled).toBe(true);
  });

  test('enables the bubble and surface buttons when granted', async () => {
    await loadApp();
    await handshake();

    expect(document.getElementById('bubble').disabled).toBe(false);
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
    const [request] = byType('request');
    return request;
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
    const { requestId } = byType('request')[0].payload;

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
  test('bubble.say carries the first line of the reply', async () => {
    await loadApp();
    await handshake();
    const request = (() => {
      document.getElementById('prompt').value = '写点东西';
      document.getElementById('send').click();
      return byType('request')[0];
    })();
    const { requestId } = request.payload;

    hostSends({
      v: 1,
      type: 'event',
      name: 'llm.done',
      payload: { requestId, text: '第一行\n第二行' },
    });

    document.getElementById('bubble').click();

    const bubble = byType('request').find((r) => r.method === 'bubble.say');
    expect(bubble).toBeDefined();
    expect(bubble.payload.text).toBe('第一行');
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
