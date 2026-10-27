import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the voice plugin's app.js, driven through its real panel.html
// markup in jsdom.
//
// The chat plugin's suite is the model, and the technique is the same: `parent` in
// jsdom IS the window, so a spy on window.postMessage is the host's inbox, and a
// dispatched MessageEvent with source=window is a frame the host sent. That covers
// what reading the source cannot - that no request precedes `init`, that the granted
// set decides which controls are usable, and that an event produces exactly the audio
// request it should.
//
// ONE document serves TWO appearances, and most of what follows is about that split:
//
//   surface.slot === 'background'  the pet's headless frame: no interface at all, it
//                                  subscribes and plays. This is the appearance that
//                                  makes the feature work with the panel closed.
//   surface.slot === 'workshop'    the workshop, hosted by the plugin market.
//
// A plugin that got the split wrong would be one of two visible bugs: the headless
// frame drawing a workshop nobody can see, or the workshop never subscribing and the
// pet going silent. Both are asserted below.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-voice');
const appPath = path.join(pluginDir, 'app.js');
const panelPath = path.join(pluginDir, 'panel.html');
const cssPath = path.join(pluginDir, 'style.css');
const manifestPath = path.join(pluginDir, 'manifest.json');

const html = readFileSync(panelPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const PLUGIN_ID = 'com.shixiansi.plugin-voice';
const PERMISSIONS = manifest.permissions;
const ALL_GRANTED = [...PERMISSIONS];

describe('style.css: the hidden attribute is authoritative', () => {
  // The same trap the chat plugin hit, and it is worth restating because the
  // mechanism is what makes it invisible: the browser's `[hidden] { display: none }`
  // lives in the USER-AGENT sheet, so any author rule that sets `display` outranks it
  // and the element stays on screen. This plugin marks two things `hidden` in its
  // markup (the background div and whichever appearance is not showing) and styles
  // `display: flex` on one of them, so without the rule a headless frame would draw a
  // workshop the host never asked for. jsdom cannot catch it either, since it does not
  // apply a stylesheet to hit-testing.
  test('a [hidden] rule exists and uses !important', () => {
    const match = css.match(/\[hidden\][^{]*\{([^}]*)\}/);
    expect(match, 'style.css has no [hidden] rule').toBeTruthy();
    expect(match[1]).toMatch(/display\s*:\s*none/);
    expect(match[1]).toMatch(/!important/);
  });

  test('the element that makes the rule load-bearing still sets display', () => {
    // `.workshop` is `display: flex` and its container is toggled with `hidden`, so
    // this is the pair the rule protects. If the flex rule ever goes, this test says
    // so rather than letting the comment describe a shape that no longer exists.
    const workshop = css.match(/\.workshop\s*\{([^}]*)\}/s);
    expect(workshop, '.workshop rule is gone; re-check what this test is guarding').toBeTruthy();
    expect(workshop[1]).toMatch(/display\s*:\s*flex/);
  });

  test('a .hidden CLASS rule exists too, because the code toggles the class', () => {
    // The engine-start command is hidden with `classList.toggle('hidden', ...)`, so the
    // CLASS needs a rule. Only `[hidden]` existed, which matches the ATTRIBUTE - a
    // different selector - so the toggle did nothing and the command stayed on screen
    // permanently, including while the engine was running, which makes the workshop look
    // like it does not know what it is doing.
    //
    // Asserted against the stylesheet rather than only behaviourally because jsdom does
    // not apply CSS to layout: a class toggle "works" in jsdom with no rule at all.
    const rule = css.match(/^\.hidden\s*\{([^}]*)\}/m);
    expect(rule, 'style.css has no .hidden class rule').toBeTruthy();
    expect(rule[1]).toMatch(/display\s*:\s*none/);
    expect(rule[1]).toMatch(/!important/);
  });

  test('every class the code hides by class has a rule to match it', () => {
    // A guard for the NEXT one: a `classList.*('hidden'` in app.js is only effective
    // because of the class rule above, so the two are checked together rather than
    // trusting that a future addition remembers.
    const appSource = readFileSync(appPath, 'utf8');
    if (/classList\.(add|toggle|remove)\('hidden'/.test(appSource)) {
      expect(css, 'app.js toggles a `hidden` class but no rule matches it')
        .toMatch(/^\.hidden\s*\{[^}]*display\s*:\s*none/m);
    }
  });

  test('no decoration paints outside an element box', () => {
    // The plugin's interface is hosted inside a window whose region the host decides.
    // box-shadow/filter/transform paint beyond the element's own border box, and the
    // excess is simply cut off - so they are banned for the same reason the pet's own
    // panel bans them.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const prop of ['box-shadow', 'filter:', 'text-shadow', 'transform:']) {
      expect(stripped, `style.css uses ${prop}, which paints outside the crop`).not.toContain(prop);
    }
  });
});

describe('manifest', () => {
  test('declares the headless frame and the permission it runs on', () => {
    // The pairing the manifest validator enforces, asserted here too so a plugin that
    // stopped asking for events fails in this repo rather than at install time.
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('events');
  });

  test('declares every capability it uses', () => {
    for (const needed of ['audio', 'events', 'storage', 'plugin.config', 'net.fetch']) {
      expect(manifest.permissions, `manifest does not ask for ${needed}`).toContain(needed);
    }
  });

  test('declares the packaged clips as assets', () => {
    // audio.import only reads files the manifest lists, so the built-in fallback works
    // exactly as far as this list is complete.
    expect(Array.isArray(manifest.assets)).toBe(true);
    expect(manifest.assets.length).toBeGreaterThan(0);
    for (const asset of manifest.assets) {
      expect(asset).toMatch(/\.wav$/);
      // Every declared asset must exist on disk, or the package promises a file it
      // does not carry.
      expect(() => readFileSync(path.join(pluginDir, asset))).not.toThrow();
    }
  });

  test('the five lines have a packaged clip each', () => {
    // The plugin's LINES table and the package must agree: a line with no clip would
    // play nothing when the user has not rendered it, which is the silent failure the
    // built-in fallback exists to prevent.
    for (const line of ['focus_end', 'break_end', 'reminder_due', 'reminder_overdue', 'reminder_none']) {
      expect(manifest.assets, `no packaged clip for ${line}`).toContain(`lines/${line}.wav`);
    }
  });

  test('the service address is a host-whitelisted setting', () => {
    // net.fetch checks the manifest's static netHosts PLUS whatever the user typed
    // into the declared host-whitelist item, so the local engine's address has to be
    // that item rather than a hardcoded host.
    const whitelisted = manifest.config.filter((c) => c.hostWhitelist);
    expect(whitelisted).toHaveLength(1);
    expect(whitelisted[0].key).toBe('ttsBaseUrl');
  });
});

let windowListeners = [];

function installPanel() {
  // innerHTML deliberately: script elements inserted that way never execute, so this
  // mounts the plugin's real markup without booting a second copy of app.js.
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  // The plugin's root element IS the <body> (`<body id="root" ...>`), so its ATTRIBUTES
  // have to be carried over too. Copying only innerHTML drops id/class/data-view, and
  // the two appearance tests then read a null element and fail for a reason that has
  // nothing to do with the plugin. This keeps the fixture faithful to the real document.
  for (const attr of ['id', 'class']) {
    const value = parsed.window.document.body.getAttribute(attr);
    if (value) document.body.setAttribute(attr, value);
  }
  const view = parsed.window.document.body.getAttribute('data-view');
  if (view) document.body.setAttribute('data-view', view);
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

/** Every request the plugin has made, as {method, payload}. */
function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function requestsFor(method) {
  return requests().filter((r) => r.method === method);
}

/** Dispatch a frame from the host (source === window === parent in jsdom). */
function hostSends(data, { source = window } = {}) {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

function initFrame({ slot = 'workshop', granted = ALL_GRANTED } = {}) {
  return {
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: PERMISSIONS,
    granted,
    surface: { kind: 'panel', slot },
  };
}

/**
 * Answers one pending request by id, the way the host does.
 *
 * The plugin routes responses by the purpose it recorded for the id, so a test that
 * wants "the settings arrived" has to reply to the actual `storage.get` it sent -
 * which is what makes these tests exercise the real routing rather than a shortcut.
 */
function hostAnswers(matchMethod, result, { ok = true, error = '' } = {}) {
  const req = requestsFor(matchMethod).slice(-1)[0];
  if (!req) throw new Error(`no ${matchMethod} request to answer`);
  hostSends({ v: 1, type: 'response', id: req.id, ok, result, error });
  return req;
}

function hostEmits(name, payload) {
  hostSends({ v: 1, type: 'event', name, payload });
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
    // Nothing may be requested before `init`: the plugin does not yet know what the
    // user granted, and guessing would both spam the host and let the interface imply
    // permissions that were never given.
    expect(byType('request')).toHaveLength(0);
  });

  test('every request before init is refused, not queued', async () => {
    await loadApp();
    // The switches exist in the markup but are disabled until the handshake lands, so
    // a click cannot produce a request. This asserts the other half: the plugin's own
    // request() refuses even if something did call it.
    const before = requests().length;
    // A click on a disabled control is what jsdom would deliver; dispatch it anyway to
    // prove the guard is in the code rather than only in the `disabled` attribute.
    document.getElementById('on-master').dispatchEvent(new Event('change', { bubbles: true }));
    expect(requests().length).toBe(before);
  });

  test('one init answers the ready frame and carries the granted set', async () => {
    await loadApp();
    hostSends(initFrame({ granted: ['audio', 'events'] }));
    await Promise.resolve();

    // The workshop asks for what it needs to draw itself, and ONLY for what it was
    // granted: a request for a permission the user declined would come back as a
    // refusal, which is a normal answer that reads like an error in the status line.
    // `audio` is granted here, so the inventory is asked for; `storage` and
    // `plugin.config` are not, so neither is requested.
    expect(requestsFor('audio.list').length).toBe(1);
    expect(requestsFor('storage.get'), 'a permission that was not granted was used').toHaveLength(0);
    expect(requestsFor('config.get'), 'a permission that was not granted was used').toHaveLength(0);
    // It must NOT subscribe: events are the headless frame's job, and a second
    // subscription from the workshop would be a promise with no one to keep it.
    expect(requestsFor('events.subscribe')).toHaveLength(0);
  });

  test('a fully granted init asks for settings, the inventory and the config', async () => {
    await loadApp();
    hostSends(initFrame({ granted: ALL_GRANTED }));
    await Promise.resolve();

    // All three, because the workshop needs all three to draw itself completely: the
    // switches and chosen takes, which clips exist, and where the engine is.
    expect(requestsFor('storage.get').length).toBe(1);
    expect(requestsFor('audio.list').length).toBe(1);
    expect(requestsFor('config.get').length).toBe(1);
  });
});

describe('the two appearances', () => {
  test('the background frame subscribes and draws nothing', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await Promise.resolve();

    const sub = requestsFor('events.subscribe');
    expect(sub, 'the headless frame did not subscribe, so the pet would never speak').toHaveLength(1);
    expect(sub[0].payload.names).toEqual(['timer.phaseEnded', 'reminder.fired']);

    // It draws nothing: the workshop must not be visible, and its controls must not be
    // rendered from a frame nobody can see.
    expect(document.getElementById('root').dataset.view).toBe('background');
    expect(document.getElementById('workshop').hidden).toBe(true);
  });

  test('the workshop does not subscribe and shows its interface', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await Promise.resolve();

    // A workshop that subscribed would hold a subscription the pet cannot deliver to
    // in this frame's lifetime, and it would still be a second subscriber.
    expect(requestsFor('events.subscribe')).toHaveLength(0);
    expect(document.getElementById('root').dataset.view).toBe('workshop');
    expect(document.getElementById('workshop').hidden).toBe(false);
  });

  test('an unknown slot is treated as the workshop rather than as the hidden frame', async () => {
    // The market mounts this document with slot "workshop"; the pet uses "background".
    // Anything else must default to the VISIBLE appearance: defaulting to the hidden
    // one would make a plugin that was mounted somewhere new appear to do nothing.
    await loadApp();
    hostSends(initFrame({ slot: '' }));
    await Promise.resolve();

    expect(document.getElementById('root').dataset.view).toBe('workshop');
  });
});

describe('the workshop renders from what the host reports', () => {
  test('the switches come up disabled until the granted set arrives', async () => {
    await loadApp();
    for (const id of ['on-master', 'on-pomodoro', 'on-reminder']) {
      expect(document.getElementById(id).disabled, `${id} is usable before init`).toBe(true);
    }
    hostSends(initFrame());
    await Promise.resolve();
    // With `audio` granted and no stored settings yet, the master switch is usable and
    // renders the store's default: off.
    expect(document.getElementById('on-master').disabled).toBe(false);
    expect(document.getElementById('on-master').checked).toBe(false);
  });

  test('stored settings are restored from the plugin own storage', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();

    hostAnswers('storage.get', {
      value: JSON.stringify({ enabled: true, pomodoro: false, reminder: true }),
    });
    await Promise.resolve();

    expect(document.getElementById('on-master').checked).toBe(true);
    expect(document.getElementById('on-pomodoro').checked).toBe(false);
    expect(document.getElementById('on-reminder').checked).toBe(true);
  });

  test('a stored blob that cannot be parsed is treated as absent', async () => {
    // The plugin's own file, edited by hand or truncated by a crash. Treating it as
    // fatal would leave the workshop unusable; treating it as absent lets the next save
    // overwrite it, which is the only recovery the user has.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', { value: '{not json' });
    await Promise.resolve();

    expect(document.getElementById('on-master').checked).toBe(false);
    expect(document.getElementById('on-master').disabled).toBe(false);
  });

  test('one row per line, and the chosen take is named in the row', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', { value: JSON.stringify({ chosen: { focus_end: 'focus_end-v002' } }) });
    hostAnswers('audio.list', [{ name: 'focus_end-v002', bytes: 100 }, { name: 'builtin-focus_end', bytes: 120 }]);
    await Promise.resolve();

    const rows = document.querySelectorAll('#lines .line');
    expect(rows.length, 'one row per declared line').toBe(5);
    const focus = document.querySelector('#lines .line[data-line="focus_end"]');
    expect(focus, 'the row does not carry the line id, so a reply cannot find it').toBeTruthy();
    expect(focus.querySelector('.badge').textContent).toContain('focus_end-v002');
    // A line with nothing chosen is reported as the built-in voice, not as blank.
    const other = document.querySelector('#lines .line[data-line="break_end"]');
    expect(other.querySelector('.badge').textContent).toContain('内置');
  });
});

describe('switching and the per-line actions', () => {
  test('a switch is saved to the plugin own storage', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    // The settings reply comes first: nothing may be written before the stored library
    // has been read, because the plugin's `settings` is the empty default until then.
    // See the data-loss regression block below.
    hostAnswers('storage.get', { value: JSON.stringify({ enabled: false }) });
    await Promise.resolve();
    const before = requestsFor('storage.set').length;

    const master = document.getElementById('on-master');
    master.checked = true;
    master.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    const saves = requestsFor('storage.set');
    expect(saves.length).toBe(before + 1);
    const saved = JSON.parse(saves.slice(-1)[0].payload.value);
    expect(saved.enabled).toBe(true);
  });

  test('auditioning a line that was never rendered asks for the packaged clip', async () => {
    // The normal state right after a character switch: the user has rendered nothing
    // for this line. Playing the built-in clip is what keeps the pet from going silent.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', { value: JSON.stringify({ chosen: {} }) });
    hostAnswers('audio.list', [{ name: 'builtin-focus_end', bytes: 120 }]);
    await Promise.resolve();

    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    const plays = requestsFor('audio.play');
    expect(plays).toHaveLength(1);
    expect(plays[0].payload.name).toBe('builtin-focus_end');
  });

  test('auditioning prefers the take the user chose', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', { value: JSON.stringify({ chosen: { focus_end: 'focus_end-v002' } }) });
    hostAnswers('audio.list', [{ name: 'focus_end-v002', bytes: 100 }, { name: 'builtin-focus_end', bytes: 120 }]);
    await Promise.resolve();

    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    expect(requestsFor('audio.play').slice(-1)[0].payload.name).toBe('focus_end-v002');
  });

  test('a chosen take that is GONE falls back to the packaged clip', async () => {
    // The plugin's stored choice outlives the file: the user can delete a take, or a
    // half-written render can leave nothing behind. Checking `chosen` against the
    // inventory rather than trusting it is what stops this being a silent line.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', { value: JSON.stringify({ chosen: { focus_end: 'focus_end-v002' } }) });
    // The host reports the clip is NOT there.
    hostAnswers('audio.list', [{ name: 'builtin-focus_end', bytes: 120 }]);
    await Promise.resolve();

    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    expect(
      requestsFor('audio.play').slice(-1)[0].payload.name,
      'a missing take must fall back rather than play nothing',
    ).toBe('builtin-focus_end');
  });

  test('the packaged clips are imported once, under names the player accepts', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    // The import writes, so it waits for the read - see the data-loss regression block.
    hostAnswers('storage.get', { value: JSON.stringify({}) });
    await Promise.resolve();

    const imports = requestsFor('audio.import');
    expect(imports.length, 'the built-in fallback was never copied in').toBe(5);
    for (const one of imports) {
      expect(one.payload.name).toMatch(/^builtin-[a-z_]+$/);
      // The source must be a path the manifest declares, or the host refuses it.
      expect(manifest.assets).toContain(one.payload.from);
    }
    // And the plugin cannot fetch its own package over HTTP, so this must be the
    // capability rather than a fetch.
    expect(requestsFor('net.fetch').filter((r) => /\.wav/.test(r.payload.url || ''))).toHaveLength(0);
  });

  test('the built-ins are imported only until the host says they are there', async () => {
    // `settings.imported` is the marker that makes this once-per-install rather than
    // once-per-launch. Re-importing would push 569 KB through the bridge on every
    // start, and would also resurrect a clip the user deliberately deleted.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', { value: JSON.stringify({ imported: true }) });
    await Promise.resolve();

    expect(
      requestsFor('audio.import'),
      'the packaged clips were copied in again although the marker says they already are',
    ).toHaveLength(0);
  });
});

describe('the switches decide what plays', () => {
  /**
   * Drive the headless frame to the point where it would answer an event.
   *
   * `clips` is the inventory the host reports. It is a parameter rather than a
   * follow-up answer because reloadState sends exactly ONE audio.list as part of the
   * handshake: answering that request twice would reply to an id the plugin had already
   * forgotten, and the second answer would be silently dropped - a test that looks like
   * it set up an inventory and did not.
   */
  async function backgroundReady(settings, clips = [{ name: 'builtin-focus_end', bytes: 120 }]) {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await Promise.resolve();
    // The settings reply FIRST, because reloadState sends that request as part of the
    // handshake: answering it out of order would test a sequence the plugin never sees.
    if (settings) {
      hostAnswers('storage.get', { value: JSON.stringify(settings) });
      await Promise.resolve();
    }
    hostAnswers('audio.list', clips);
    await Promise.resolve();
  }

  test('a focus phase plays the focus line when the switches allow it', async () => {
    await backgroundReady({ enabled: true, pomodoro: true, chosen: {} });
    const before = requestsFor('audio.play').length;

    hostEmits('timer.phaseEnded', { phase: 'focus' });
    await Promise.resolve();

    const plays = requestsFor('audio.play');
    expect(plays.length).toBe(before + 1);
    expect(plays.slice(-1)[0].payload.name).toBe('builtin-focus_end');
  });

  test('a break phase plays the break line, not the focus one', async () => {
    // The host's payload says "break" for both a short and a long break; which line to
    // say is the plugin's decision, which is why this is asserted here.
    await backgroundReady({ enabled: true, pomodoro: true, chosen: {} },
      [{ name: 'builtin-break_end', bytes: 100 }]);

    hostEmits('timer.phaseEnded', { phase: 'break' });
    await Promise.resolve();

    expect(requestsFor('audio.play').slice(-1)[0].payload.name).toBe('builtin-break_end');
  });

  test('the master switch OFF keeps the pet silent', async () => {
    await backgroundReady({ enabled: false, pomodoro: true, chosen: {} });
    const before = requestsFor('audio.play').length;

    hostEmits('timer.phaseEnded', { phase: 'focus' });
    hostEmits('reminder.fired', { due: 1, overdue: 0, total: 1 });
    await Promise.resolve();

    expect(requestsFor('audio.play').length, 'a switched-off plugin spoke').toBe(before);
  });

  test('the per-notice switch is independent of the master switch', async () => {
    // The reminder switch defaults OFF because a reminder can fire mid-meeting, so
    // "pomodoro on, reminders silent" is the state the plugin must get right.
    await backgroundReady({ enabled: true, pomodoro: true, reminder: false, chosen: {} });
    const before = requestsFor('audio.play').length;

    hostEmits('reminder.fired', { due: 1, overdue: 0, total: 1 });
    await Promise.resolve();
    expect(requestsFor('audio.play').length, 'a reminder spoke while its switch was off').toBe(before);

    hostEmits('timer.phaseEnded', { phase: 'focus' });
    await Promise.resolve();
    expect(requestsFor('audio.play').length).toBe(before + 1);
  });

  test('the reminder payload chooses between the three reminder lines', async () => {
    await backgroundReady({ enabled: true, reminder: true, chosen: {} }, [
      { name: 'builtin-reminder_due', bytes: 1 },
      { name: 'builtin-reminder_overdue', bytes: 1 },
      { name: 'builtin-reminder_none', bytes: 1 },
    ]);

    const cases = [
      [{ due: 3, overdue: 0, total: 3 }, 'builtin-reminder_due'],
      [{ due: 1, overdue: 2, total: 3 }, 'builtin-reminder_overdue'],
      [{ due: 0, overdue: 0, total: 0 }, 'builtin-reminder_none'],
    ];
    for (const [payload, want] of cases) {
      hostEmits('reminder.fired', payload);
      await Promise.resolve();
      expect(
        requestsFor('audio.play').slice(-1)[0].payload.name,
        `payload ${JSON.stringify(payload)} chose the wrong line`,
      ).toBe(want);
    }
  });

  test('the chosen take is what plays, not the packaged clip', async () => {
    // The end-to-end point of the whole plugin: the user's own render wins.
    await backgroundReady(
      { enabled: true, pomodoro: true, chosen: { focus_end: 'focus_end-v002' } },
      [{ name: 'focus_end-v002', bytes: 100 }, { name: 'builtin-focus_end', bytes: 120 }],
    );

    hostEmits('timer.phaseEnded', { phase: 'focus' });
    await Promise.resolve();

    expect(requestsFor('audio.play').slice(-1)[0].payload.name).toBe('focus_end-v002');
  });

  test('an event with no switch state yet does not speak', async () => {
    // Events can arrive before the first settings reply comes back from the host. The
    // default is off, and off must mean silent rather than "assume on".
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await Promise.resolve();

    hostEmits('timer.phaseEnded', { phase: 'focus' });
    await Promise.resolve();
    expect(requestsFor('audio.play')).toHaveLength(0);
  });

  test('an unknown event name is ignored rather than guessed at', async () => {
    await backgroundReady({ enabled: true, pomodoro: true, chosen: {} });
    const before = requestsFor('audio.play').length;
    hostEmits('something.else', { phase: 'focus' });
    await Promise.resolve();
    expect(requestsFor('audio.play').length).toBe(before);
  });
});

describe('rendering a line', () => {
  /**
   * Drives the whole render sequence up to the /tts call.
   *
   * The sequence is three requests now - set_gpt_weights, set_sovits_weights, then the
   * render - so a helper is the only way these tests stay about the behaviour rather
   * than about the number of hops. Returns the render request, which is the one the
   * caller then answers.
   */
  async function driveToRender() {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    // The settings reply comes first, then the config: a render ADOPTS the take it
    // produced, and adopting writes - which must not happen before the stored library
    // has been read (see the data-loss regression block).
    hostAnswers('storage.get', { value: JSON.stringify({}) });
    await Promise.resolve();
    hostAnswers('config.get', {
      values: {
        ttsBaseUrl: 'http://127.0.0.1:9880',
        gptPath: 'g.ckpt', sovitsPath: 's.pth', refPath: 'r.wav',
      },
    });
    await Promise.resolve();

    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    const button = row.querySelector('.btn-generate');
    button.dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    for (const marker of ['set_gpt_weights', 'set_sovits_weights']) {
      const step = requestsFor('net.fetch').filter((r) => r.payload.url.includes(marker)).slice(-1)[0];
      if (!step) throw new Error(`the ${marker} step never happened`);
      hostSends({ v: 1, type: 'response', id: step.id, ok: true, result: { status: 200, body: 'ok' } });
      await Promise.resolve();
    }
    const render = requestsFor('net.fetch').filter((r) => r.payload.method === 'POST').slice(-1)[0];
    return { render, button, row };
  }

  test('generating asks for BYTES, not text', async () => {
    // A synthesis engine answers with audio/wav. The text form of a response body is
    // LOSSY for anything that is not valid UTF-8 - every 0x80+ byte comes back as
    // U+FFFD - so the file is the right size and plays as noise. It looked like it had
    // worked, which is what made this worth a test.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('config.get', {
      values: {
        ttsBaseUrl: 'http://127.0.0.1:9880',
        gptPath: 'g.ckpt', sovitsPath: 's.pth', refPath: 'r.wav',
      },
    });
    await Promise.resolve();

    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn-generate').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    // The render is the THIRD call: the two weight switches come first, because the
    // engine keeps one model loaded and posting straight to /tts would synthesise with
    // whichever character was loaded last.
    const gpt = requestsFor('net.fetch').filter((r) => r.payload.url.includes('set_gpt_weights'))[0];
    expect(gpt, 'the GPT weights were never set').toBeTruthy();
    hostSends({ v: 1, type: 'response', id: gpt.id, ok: true, result: { status: 200, body: 'ok' } });
    await Promise.resolve();
    const sovits = requestsFor('net.fetch').filter((r) => r.payload.url.includes('set_sovits_weights'))[0];
    expect(sovits, 'the SoVITS weights were never set').toBeTruthy();
    hostSends({ v: 1, type: 'response', id: sovits.id, ok: true, result: { status: 200, body: 'ok' } });
    await Promise.resolve();

    const fetches = requestsFor('net.fetch').filter((r) => r.payload.method === 'POST');
    expect(fetches, 'no render request was made').toHaveLength(1);
    expect(fetches[0].payload.encoding, 'the render would ask for the lossy text form').toBe('base64');
    expect(fetches[0].payload.url).toBe('http://127.0.0.1:9880/tts');
  });

  test('generating without the three weight paths refuses before asking', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('config.get', { values: { ttsBaseUrl: 'http://127.0.0.1:9880' } });
    await Promise.resolve();

    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn-generate').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    expect(
      requestsFor('net.fetch').filter((r) => r.payload.method === 'POST'),
      'a render was attempted with no model configured',
    ).toHaveLength(0);
  });

  test('the plugin never tries to start the engine', async () => {
    // A plugin has no capability that launches a process, and adding one would hand
    // every installed plugin arbitrary code execution. The workshop reports the state
    // and the user starts the service - so there must be no such request to make.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('config.get', { values: { ttsBaseUrl: 'http://127.0.0.1:9880' } });
    await Promise.resolve();

    for (const r of requests()) {
      expect(r.method).not.toMatch(/engine|process|exec|spawn|start/i);
    }
  });

  test('a render does not become the live take until it is saved', async () => {
    // The studio's contract, kept: a bad render costs nothing because the user has not
    // adopted it. The take is remembered only after audio.save confirms the write.
    const { render } = await driveToRender();
    expect(render, 'the render request never happened').toBeTruthy();

    const savesBefore = requestsFor('storage.set').length;
    hostSends({
      v: 1,
      type: 'response',
      id: render.id,
      ok: true,
      result: { status: 200, body: 'UklGRg==', encoding: 'base64' },
    });
    await Promise.resolve();

    // The audio was saved, and nothing claims it is live YET - the save has not been
    // confirmed by the host.
    expect(requestsFor('audio.save').length, 'the rendered audio was not stored').toBe(1);
    expect(requestsFor('storage.set').length, 'the take went live before it was saved').toBe(savesBefore);

    // Confirm the write, and only now does it become the chosen take.
    hostAnswers('audio.save', { name: 'focus_end-v001', bytes: 4 });
    await Promise.resolve();
    const saved = JSON.parse(requestsFor('storage.set').slice(-1)[0].payload.value);
    expect(saved.chosen.focus_end, 'the saved take was never adopted').toBeTruthy();
  });

  test('an engine error is reported and the button comes back', async () => {
    const { render, button } = await driveToRender();
    expect(render, 'the render request never happened').toBeTruthy();

    // The engine answered, but not with audio.
    hostSends({
      v: 1, type: 'response', id: render.id, ok: true,
      result: { status: 500, body: 'boom' },
    });
    await Promise.resolve();

    expect(requestsFor('audio.save'), 'a failed render was stored anyway').toHaveLength(0);
    // The button must be usable again: leaving it disabled would make one bad render
    // look like a broken plugin.
    expect(button.disabled, 'the button stayed disabled after a failed render').toBe(false);
  });
});

describe('the character column', () => {
  // These exist because the column was DEAD: the character list was a module-level
  // array nothing filled, the renderer was only reachable from its own click handler,
  // and the adopt-all button had no listener at all. Reading the source did not reveal
  // it - the code all looked present - so the only way this stays fixed is a test that
  // drives the real startup path.

  test('the characters come from the migrated library', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', {
      value: JSON.stringify({
        roleNames: { yoimiya: '宵宫', klee: '可莉' },
        takes: {},
        chosen: {},
      }),
    });
    await Promise.resolve();

    const items = document.querySelectorAll('#roles .role');
    expect(items.length, 'the character column did not render from the library').toBe(2);
    const names = [...items].map((li) => li.querySelector('.role-name').textContent);
    expect(names).toContain('宵宫');
    expect(names).toContain('可莉');
  });

  test('a character with no renders is marked 0 of 5 rather than hidden', async () => {
    // The studio's 待生成 state, kept. Switching to a character that has recorded
    // nothing changes no sound, so the count is the only thing that makes the click
    // honest.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', {
      value: JSON.stringify({ roleNames: { klee: '可莉' }, takes: {}, chosen: {} }),
    });
    hostAnswers('audio.list', []);
    await Promise.resolve();

    const item = document.querySelector('#roles .role');
    expect(item.querySelector('.role-count').textContent).toBe('0 / 5');
  });

  test('a character whose renders are all on disk is counted as 5 of 5', async () => {
    const takes = {};
    for (const line of ['focus_end', 'break_end', 'reminder_due', 'reminder_overdue', 'reminder_none']) {
      takes[line] = [{ name: `${line}-v001`, role: 'yoimiya', roleName: '宵宫' }];
    }
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', {
      value: JSON.stringify({ roleNames: { yoimiya: '宵宫' }, takes, chosen: {} }),
    });
    hostAnswers('audio.list', Object.keys(takes).map((l) => ({ name: `${l}-v001`, bytes: 10 })));
    await Promise.resolve();

    expect(document.querySelector('#roles .role .role-count').textContent).toBe('5 / 5');
  });

  test('clicking a character switches the active one and saves it', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', {
      value: JSON.stringify({ roleNames: { yoimiya: '宵宫', klee: '可莉' }, activeRole: 'klee', takes: {} }),
    });
    await Promise.resolve();

    const before = requestsFor('storage.set').length;
    const yoimiya = [...document.querySelectorAll('#roles .role')]
      .find((li) => li.dataset.role === 'yoimiya');
    expect(yoimiya, 'the row does not carry its role id').toBeTruthy();
    yoimiya.dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    const saves = requestsFor('storage.set');
    expect(saves.length).toBe(before + 1);
    expect(JSON.parse(saves.slice(-1)[0].payload.value).activeRole).toBe('yoimiya');
    // And the row is marked active, so the user can see which one is in effect.
    const nowActive = [...document.querySelectorAll('#roles .role.active')]
      .map((li) => li.dataset.role);
    expect(nowActive).toEqual(['yoimiya']);
  });

  test('adopting a whole character is one click and changes every recorded line', async () => {
    // The direct answer to "I picked a character, now what?". It is a purely LOCAL
    // operation: the renders already exist, so adopting must not touch the engine.
    const takes = {
      focus_end: [{ name: 'focus_end-v002', role: 'yoimiya', roleName: '宵宫' }],
      break_end: [{ name: 'break_end-v001', role: 'yoimiya', roleName: '宵宫' }],
      // A line this character has NOT recorded: it must be left alone rather than
      // pointed at a file that does not exist.
      reminder_due: [{ name: 'reminder_due-v001', role: 'nahida', roleName: '纳西妲' }],
    };
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', {
      value: JSON.stringify({ roleNames: { yoimiya: '宵宫' }, activeRole: 'yoimiya', takes, chosen: {} }),
    });
    hostAnswers('audio.list', [
      { name: 'focus_end-v002', bytes: 10 },
      { name: 'break_end-v001', bytes: 10 },
      { name: 'reminder_due-v001', bytes: 10 },
    ]);
    await Promise.resolve();

    const fetchesBefore = requestsFor('net.fetch').length;
    document.getElementById('adopt-all').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    const saved = JSON.parse(requestsFor('storage.set').slice(-1)[0].payload.value);
    expect(saved.chosen.focus_end, 'the recorded line was not adopted').toBe('focus_end-v002');
    expect(saved.chosen.break_end).toBe('break_end-v001');
    // The unrecorded line keeps whatever it had: nothing.
    expect(saved.chosen.reminder_due, 'a line with no take for this character was adopted anyway').toBeUndefined();
    // And nothing was rendered: adopting is local.
    expect(requestsFor('net.fetch').length).toBe(fetchesBefore);
  });

  test('the adopt button is disabled when there is nothing to adopt', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', { value: JSON.stringify({ roleNames: {}, takes: {} }) });
    await Promise.resolve();

    expect(document.getElementById('adopt-all').disabled).toBe(true);
  });
});

describe('rendering a line switches the engine weights first', () => {
  // The engine keeps ONE model loaded, so posting only to /tts synthesises with
  // whatever was loaded last. Without the two weight calls, "switch character" would
  // change the interface and not the voice - the exact class of bug this whole change
  // is about.

  async function readyToRender() {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('config.get', {
      values: {
        ttsBaseUrl: 'http://127.0.0.1:9880',
        gptPath: 'D:/models/yoimiya/gpt.ckpt',
        sovitsPath: 'D:/models/yoimiya/sovits.pth',
        refPath: 'D:/models/yoimiya/ref.wav',
      },
    });
    await Promise.resolve();
  }

  test('the GPT weights are set before anything is synthesised', async () => {
    await readyToRender();
    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn-generate').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    // Filtered by URL rather than taking the first net.fetch: the workshop also PROBES
    // the engine as part of its first paint, so position is not a reliable identity.
    const weights = requestsFor('net.fetch').filter((r) => r.payload.url.includes('set_gpt_weights'));
    expect(weights, 'the GPT weights were never set, so the render would use the previous character')
      .toHaveLength(1);
    expect(decodeURIComponent(weights[0].payload.url)).toContain('D:/models/yoimiya/gpt.ckpt');
    // Nothing may be synthesised yet: the model has not finished loading.
    expect(requestsFor('net.fetch').filter((r) => /\/tts$/.test(r.payload.url))).toHaveLength(0);
  });

  test('the SoVITS weights follow, and the render comes last', async () => {
    await readyToRender();
    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn-generate').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    // Answer the first call, which is what makes the second one happen.
    const gpt = requestsFor('net.fetch').filter((r) => r.payload.url.includes('set_gpt_weights'))[0];
    hostSends({ v: 1, type: 'response', id: gpt.id, ok: true, result: { status: 200, body: 'ok' } });
    await Promise.resolve();

    const sovits = requestsFor('net.fetch').filter((r) => r.payload.url.includes('set_sovits_weights'));
    expect(sovits, 'the SoVITS weights were never set').toHaveLength(1);
    expect(decodeURIComponent(sovits[0].payload.url)).toContain('D:/models/yoimiya/sovits.pth');
    expect(requestsFor('net.fetch').filter((r) => /\/tts$/.test(r.payload.url))).toHaveLength(0);

    hostSends({ v: 1, type: 'response', id: sovits[0].id, ok: true, result: { status: 200, body: 'ok' } });
    await Promise.resolve();

    const renders = requestsFor('net.fetch').filter((r) => /\/tts$/.test(r.payload.url));
    expect(renders, 'the render never happened after the weights were set').toHaveLength(1);
    expect(renders[0].payload.method).toBe('POST');
    expect(renders[0].payload.encoding).toBe('base64');
  });

  test('a known-dead engine refuses BEFORE sending a doomed render', async () => {
    // The G4 criterion, and the reason engineUp has three states rather than two: a
    // probe that definitely failed must block the render and say why, while an
    // UNANSWERED probe is "unknown" and must not - blocking on unknown would leave the
    // button dead until a probe happened to complete.
    await readyToRender();

    // The engine probe that the config reply triggers fails.
    const probe = requestsFor('net.fetch').filter((r) => r.payload.method === 'GET').slice(-1)[0];
    expect(probe, 'the workshop never probed the engine').toBeTruthy();
    hostSends({ v: 1, type: 'response', id: probe.id, ok: false, error: '语音服务未运行' });
    await Promise.resolve();

    const before = requestsFor('net.fetch').length;
    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn-generate').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    // No weight call and no render: the work was refused up front.
    const after = requestsFor('net.fetch').slice(before);
    expect(after.filter((r) => r.payload.url.includes('set_gpt_weights')),
      'a render was attempted although the engine is known to be down').toHaveLength(0);
    expect(after.filter((r) => /\/tts$/.test(r.payload.url))).toHaveLength(0);
    expect(document.getElementById('status').textContent).toContain('未运行');
  });

  test('an UNANSWERED engine probe does not block a render', async () => {
    // Unknown is not down. The probe is sent and never answered here, which is the
    // state a slow or firewall-dropped connection leaves the plugin in.
    await readyToRender();

    const before = requestsFor('net.fetch').length;
    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn-generate').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    const after = requestsFor('net.fetch').slice(before);
    expect(after.filter((r) => r.payload.url.includes('set_gpt_weights')),
      'an unanswered probe blocked a render, so the button is dead until a probe completes')
      .toHaveLength(1);
  });

  test('a failed probe shows the command that starts the engine', async () => {
    // The plugin cannot start it, so the text IS the help. Shown only on a DEFINITE
    // failure: printing a command at someone whose engine is merely slow would tell
    // them to start something already running.
    await readyToRender();
    expect(document.getElementById('engine-help').classList.contains('hidden'),
      'the start command is shown before anything was probed').toBe(true);

    const probe = requestsFor('net.fetch').filter((r) => r.payload.method === 'GET').slice(-1)[0];
    hostSends({ v: 1, type: 'response', id: probe.id, ok: false, error: '语音服务未运行' });
    await Promise.resolve();

    const help = document.getElementById('engine-help');
    expect(help.classList.contains('hidden'), 'the start command was not shown').toBe(false);
    expect(help.textContent).toContain('api_v2.py');
    // It is text, not a button: there must be nothing here that launches anything.
    expect(help.querySelector('button'), 'the help offers a button to start a process').toBeNull();
  });

  test('an unanswered probe does not print a start command', async () => {
    await readyToRender();
    // No reply at all: unknown, so no advice.
    expect(document.getElementById('engine-help').classList.contains('hidden')).toBe(true);
  });

  test('a failed weight call re-enables the button instead of stranding it', async () => {
    // Without this, one failure leaves the line permanently unrenderable: the button
    // was disabled when the sequence began and nothing else would turn it back on.
    await readyToRender();
    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    const button = row.querySelector('.btn-generate');
    button.dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    const gpt = requestsFor('net.fetch').filter((r) => r.payload.url.includes('set_gpt_weights'))[0];
    hostSends({ v: 1, type: 'response', id: gpt.id, ok: false, error: '语音服务未运行' });
    await Promise.resolve();

    expect(button.disabled, 'the button stayed disabled after a failed render').toBe(false);
    expect(requestsFor('net.fetch').filter((r) => /\/tts$/.test(r.payload.url))).toHaveLength(0);
    expect(document.getElementById('status').textContent).toContain('语音服务未运行');
  });
});

describe('nothing is written before the stored settings have been read', () => {
  // THE DATA-LOSS REGRESSION. The plugin imports its packaged clips during the
  // handshake, and the import was followed by a save. `settings` is the empty default
  // until the storage reply lands, so that save REPLACED a migrated library with
  // `{activeRole:"",chosen:{},takes:{},roleNames:{}}`.
  //
  // The shape of the damage is what makes it worth a test rather than a comment: the
  // audio survived and the pointer to it did not, so the pet spoke the packaged voice
  // while a `.migrated` marker promised everything was fine and 12 clips sat unreachable
  // on disk. It was found on a real install, not by reading the code.

  test('a save never precedes the settings read', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();

    // At this point the read has been SENT and not answered. Any storage.set here would
    // be writing the empty default over whatever the user has.
    expect(
      requestsFor('storage.set'),
      'the plugin saved before it had read, which overwrites the stored library with defaults',
    ).toHaveLength(0);
  });

  test('the packaged clips are imported only after the read', async () => {
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();

    // The import is what used to trigger the destructive save, so it must not have run
    // yet either.
    expect(requestsFor('audio.import'), 'the built-ins were imported before the read').toHaveLength(0);

    hostAnswers('storage.get', {
      value: JSON.stringify({
        activeRole: 'yoimiya',
        roleNames: { yoimiya: '宵宫' },
        chosen: { focus_end: 'focus_end-v002' },
        takes: { focus_end: [{ name: 'focus_end-v002', role: 'yoimiya' }] },
      }),
    });
    await Promise.resolve();

    // Now it may import, and the import may save - but the save must carry the library
    // that was READ, not the default.
    expect(requestsFor('audio.import').length, 'the built-ins were never imported').toBe(5);
    const saves = requestsFor('storage.set');
    for (const save of saves) {
      const written = JSON.parse(save.payload.value);
      expect(written.activeRole, 'a save dropped the active character').toBe('yoimiya');
      expect(written.chosen.focus_end, 'a save dropped the chosen take').toBe('focus_end-v002');
      expect(Object.keys(written.roleNames).length, 'a save dropped the characters').toBe(1);
    }
  });

  test('a library that arrives after an early save attempt is still intact', async () => {
    // The end state, asserted directly: whatever the plugin did during the handshake,
    // what it holds after the read is the library and not the default.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', {
      value: JSON.stringify({
        activeRole: 'yoimiya',
        roleNames: { yoimiya: '宵宫', klee: '可莉' },
        chosen: { focus_end: 'focus_end-v002', break_end: 'break_end-v001' },
        takes: { focus_end: [{ name: 'focus_end-v002', role: 'yoimiya' }] },
      }),
    });
    hostAnswers('audio.list', [
      { name: 'focus_end-v002', bytes: 10 },
      { name: 'builtin-focus_end', bytes: 10 },
    ]);
    await Promise.resolve();

    const active = document.querySelector('#roles .role.active');
    expect(active, 'the active character did not survive the handshake').toBeTruthy();
    expect(active.dataset.role).toBe('yoimiya');
    const focus = document.querySelector('#lines .line[data-line="focus_end"] .badge');
    expect(focus.textContent).toContain('focus_end-v002');
  });

  test('with no storage permission the plugin still works, in memory', async () => {
    // No read to wait for, so gating on it would leave the switches doing nothing at
    // all. The save is simply refused, which is a normal answer.
    await loadApp();
    hostSends(initFrame({ granted: ['audio', 'events'] }));
    await Promise.resolve();

    const master = document.getElementById('on-master');
    expect(master.disabled, 'the switch is unusable because a read can never arrive').toBe(false);
    master.checked = true;
    master.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    const saves = requestsFor('storage.set');
    expect(saves, 'the switch was not even attempted').toHaveLength(1);
    expect(JSON.parse(saves[0].payload.value).enabled).toBe(true);
  });
});

describe('refusals are normal answers', () => {
  test('a refused capability does not break the interface', async () => {
    // The market has no todos, no pomodoro and no pet, and it does not implement
    // events.subscribe either. The same document runs in both programs, so a refusal
    // has to read as an answer rather than as a failure.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();

    hostAnswers('config.get', null, { ok: false, error: '插件未获权限 plugin.config' });
    await Promise.resolve();

    // The workshop still renders and is still usable.
    expect(document.querySelectorAll('#lines .line').length).toBe(5);
    expect(document.getElementById('on-master').disabled).toBe(false);
    expect(document.getElementById('status').textContent).toContain('plugin.config');
  });

  test('a refused audio.list leaves the packaged fallback in place', async () => {
    // Without the inventory the plugin cannot know what is on disk, so it must fall
    // back to the packaged clip rather than play a name it cannot verify.
    await loadApp();
    hostSends(initFrame());
    await Promise.resolve();
    hostAnswers('storage.get', { value: JSON.stringify({ chosen: { focus_end: 'focus_end-v002' } }) });
    hostAnswers('audio.list', null, { ok: false, error: '未获权限 audio' });
    await Promise.resolve();

    const row = document.querySelector('#lines .line[data-line="focus_end"]');
    row.querySelector('.btn').dispatchEvent(new Event('click', { bubbles: true }));
    await Promise.resolve();

    expect(requestsFor('audio.play').slice(-1)[0].payload.name).toBe('builtin-focus_end');
  });
});

describe('the pomodoro publishes phase-ended, and this plugin polls for it (1.0.2)', () => {
  // WHY THIS BLOCK EXISTS: `timer.phaseEnded` was the HOST's event, and the host's timer retired in
  // stage 2 - so the two spoken lines went silent with nothing left to subscribe to. The pomodoro
  // plugin now publishes the same fact through `plugin.share`, and this frame polls it. The
  // subscription above is KEPT so a future host emitter would restore the old path unchanged; these
  // tests pin the path that works today.

  const factValue = (at, phase = 'focus') => JSON.stringify({ phase, at });

  /** Boots the headless frame with the settings already answered, so a line can actually play. */
  async function readyBackground(settings) {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await Promise.resolve();
    // The settings reply FIRST: reloadState sends that request as part of the handshake, and
    // answering it out of order would test a sequence the plugin never sees.
    hostAnswers('storage.get', { value: JSON.stringify(settings) });
    await Promise.resolve();
    hostAnswers('audio.list', []);
    await Promise.resolve();
  }

  /** Answers the most recent share.get. Returns the request, or null when the frame did not poll. */
  function answerPoll(value) {
    const poll = requestsFor('share.get').slice(-1)[0];
    if (!poll) return null;
    hostSends({ v: 1, type: 'response', id: poll.id, ok: true, result: { value } });
    return poll;
  }

  test('it asks the pomodoro plugin for the fact, and only from the background frame', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await Promise.resolve();

    const polls = requestsFor('share.get');
    expect(polls.length, 'the headless frame never polled for the phase fact').toBeGreaterThan(0);
    expect(polls[0].payload).toEqual({
      owner: 'com.shixiansi.plugin-pomodoro',
      name: 'phase-ended',
    });
  });

  test('the workshop does not poll: the line belongs to the hidden frame', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await Promise.resolve();
    // Polling from the workshop would play the line only when the user happened to have the
    // workshop open, which is the opposite of what "the pet speaks while you work" means.
    expect(requestsFor('share.get')).toHaveLength(0);
  });

  test('a new phase ending speaks the line for that phase', async () => {
    await readyBackground({ enabled: true, pomodoro: true, chosen: {} });
    const before = requestsFor('audio.play').length;

    answerPoll(factValue(1_700_000_000_000, 'focus'));
    await Promise.resolve();

    const plays = requestsFor('audio.play').slice(before);
    expect(plays, 'a finished focus did not speak').toHaveLength(1);
  });

  test('the same deadline is spoken ONCE - a poll loop must not repeat it', async () => {
    await readyBackground({ enabled: true, pomodoro: true, chosen: {} });
    const at = 1_700_000_000_000;
    const before = requestsFor('audio.play').length;

    // The pomodoro publishes the same value until the NEXT phase ends, so every poll sees it again.
    // Without the `at` guard the line would play every two seconds forever.
    answerPoll(factValue(at));
    await Promise.resolve();
    expect(requestsFor('audio.play').length).toBe(before + 1);

    answerPoll(factValue(at));
    await Promise.resolve();
    expect(requestsFor('audio.play').length, 'the same ending was spoken twice').toBe(before + 1);
  });

  test('a LATER deadline speaks again, even for the same phase', async () => {
    await readyBackground({ enabled: true, pomodoro: true, chosen: {} });
    const before = requestsFor('audio.play').length;

    answerPoll(factValue(1_700_000_000_000));
    await Promise.resolve();
    // The next poll is issued by the 2 s INTERVAL, not by the reply, so wait for it rather than
    // assuming a reply-to-reply chain the plugin does not have.
    await new Promise((r) => setTimeout(r, 2100));
    answerPoll(factValue(1_700_001_500_000));
    await Promise.resolve();

    expect(requestsFor('audio.play').length, 'a second session was not announced').toBe(before + 2);
  });

  test('an empty or unreadable value is "nothing to say", not an error', async () => {
    await readyBackground({ enabled: true, pomodoro: true, chosen: {} });
    const before = requestsFor('audio.play').length;

    // "Nobody published yet" is the ordinary answer: the key is empty until a phase ends, and empty
    // again after the pomodoro plugin restarts.
    answerPoll('');
    await Promise.resolve();
    answerPoll('not json');
    await Promise.resolve();

    expect(requestsFor('audio.play').length).toBe(before);
  });
});
