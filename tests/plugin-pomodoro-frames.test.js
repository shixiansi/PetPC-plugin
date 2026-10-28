import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, test } from 'vitest';

// Behaviour tests for the pomodoro plugin's TWO FRAMES (2.1.0).
//
// What this file is for: 2.1.0 moved the clock out of the surface's document and into the host's
// headless frame. That split is the kind of change that can look right in the source and be wrong in
// the running document, so three sentences are asserted against the messages a frame actually posts:
//
//   1. the TIMER writes state and records, publishes `phase-ended`, and touches no DOM;
//   2. the VIEW never writes state - it publishes a `command` and reads state back;
//   3. the fact the voice plugin consumes carries the phase's DEADLINE and is one-shot.
//
// The third is the whole point: `timer.phaseEnded` had no emitter after the host retired its timer,
// so the voice plugin's two lines were silent.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-pomodoro');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const source = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const machineSrc = readFileSync(path.join(pluginDir, 'machine.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const STATE_KEY = 'pomodoro-state-v2';
const RECORDS_KEY = 'pomodoro-records-v2';

// The machine as one expression, so the app's `import` can resolve against a window global. In the
// browser the bundle supplies this; in jsdom there is no module loader.
const MACHINE_NS =
  ';(function(){' +
  machineSrc.replace(/^export /gm, '') +
  // `settingOn` must be listed here like every other export: this list IS the module as the page
  // sees it, so an export that is missing makes `machine.settingOn` undefined inside the plugin -
  // which is a TypeError swallowed by the interval callback, i.e. a feature that silently does
  // nothing while the test that called it looks fine.
  ';return {settingOn, emptyState, isRunning, remainingMs, formatCountdown, phaseLabel, startFocus, pause,' +
  ' resume, stop, reset, finishPhase, skipPhase, reconcile, isBreakPhase, phaseDurationMs,' +
  ' ceilSeconds, formatSeconds, PHASE_IDLE, PHASE_FOCUS, PHASE_SHORT_BREAK, PHASE_LONG_BREAK,' +
  ' RUN_RUNNING, RUN_PAUSED, RUN_STOPPED};})()';

/** Boots one appearance of the plugin and returns the frame's outbox. */
function mount({ slot, kind = 'surface', granted }) {
  const dom = new JSDOM(html, {
    url: 'https://plugin.invalid/panel.html',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const sent = [];
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);
  window.__machine = window.eval(MACHINE_NS);

  window.eval(
    source.replace("import * as machine from './machine.js';", 'const machine = window.__machine;'),
  );

  const say = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  return {
    window,
    sent,
    init: () => say({ v: 1, type: 'init', theme: 'dark', granted, surface: { slot, kind } }),
    respond: (id, result, ok = true) => say({ v: 1, type: 'response', id, ok, result }),
  };
}

const granted = ['storage', 'plugin.share', 'plugin.config', 'pet.surface', 'pet.bubble', 'events'];
const allOf = (sent, method) => sent.filter((m) => m.method === method);
const lastOf = (sent, method) => [...sent].reverse().find((m) => m.method === method);

/** The last state read the frame issued, so the test can answer it. */
const lastStateRead = (sent) =>
  allOf(sent, 'storage.get')
    .filter((m) => m.payload.key === STATE_KEY)
    .at(-1);

// `enabled: true` on every fixture: reconcile() returns early unless the timer is enabled, and
// emptyState() defaults it off - correct for a fresh install, wrong for a fixture that wants the
// clock to run.
const endedState = (phase, endsAt) => ({
  enabled: true,
  phase,
  runState: 'running',
  endsAt: endsAt || Date.now() - 1000,
  phaseStartedAt: (endsAt || Date.now()) - 26 * 60 * 1000,
  completedCount: 0,
  currentTodoId: 't1',
  currentTodoTitle: '写周报',
  asking: '',
});

describe('pomodoro 2.1.0: the manifest asks for a headless frame', () => {
  test('it declares background and holds a permission that gates one', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('events');
    expect(manifest.permissions).toContain('plugin.share');
  });

  test('it still declares its surface, so right-clicking the pet opens something', () => {
    expect(Array.isArray(manifest.surface) && manifest.surface.length > 0).toBe(true);
  });
});

describe('pomodoro 2.1.0: the timer frame', () => {
  test('it reads state and records', () => {
    const { sent, init } = mount({ slot: 'background', granted });
    init();
    expect(allOf(sent, 'storage.get').some((m) => m.payload.key === STATE_KEY)).toBe(true);
    expect(allOf(sent, 'storage.get').some((m) => m.payload.key === RECORDS_KEY)).toBe(true);
  });

  test('it draws nothing: the document stays at its boot state', () => {
    const { window, init } = mount({ slot: 'background', granted });
    init();
    expect(window.document.getElementById('countdown').textContent).toBe('--:--');
    expect(window.document.getElementById('root').className).toBe('view-background');
  });

  test('a finished focus publishes the fact AND parks on the summary gate', async () => {
    const endedAt = 1_700_000_000_000;
    const { sent, init, respond } = mount({ slot: 'background', granted });
    init();
    respond(lastStateRead(sent).id, { value: JSON.stringify(endedState('focus', endedAt)) });
    sent.length = 0;

    // One tick, and it is on a 1 s interval.
    await new Promise((r) => setTimeout(r, 1200));

    const fact = allOf(sent, 'share.set').find((m) => m.payload.name === 'phase-ended');
    expect(fact, 'no phase-ended was published: the voice plugin stays silent').toBeTruthy();
    expect(JSON.parse(fact.payload.value)).toEqual({ phase: 'focus', at: endedAt });

    const wrote = allOf(sent, 'storage.set').find((m) => m.payload.key === STATE_KEY);
    expect(wrote, 'the timer did not persist the ended state').toBeTruthy();
    expect(JSON.parse(wrote.payload.value).asking).toBe('summary');
  });

  test('a finished break publishes "break", which is the other spoken line', async () => {
    const { sent, init, respond } = mount({ slot: 'background', granted });
    init();
    respond(lastStateRead(sent).id, { value: JSON.stringify(endedState('shortBreak')) });
    sent.length = 0;

    await new Promise((r) => setTimeout(r, 1200));

    const fact = allOf(sent, 'share.set').find((m) => m.payload.name === 'phase-ended');
    expect(fact).toBeTruthy();
    expect(JSON.parse(fact.payload.value).phase).toBe('break');
  });

  test('停止 ends the session instead of pausing it', async () => {
    // The machine's own `stop` is deliberately "a pause the user asked for: recoverable", and a
    // machine test pins that. The BUTTON is 停止, though, and a 停止 that resumes into the same
    // session is indistinguishable from 暂停 on screen - which is the bug the user reported. So the
    // command layer maps 停止 onto `reset`: no phase, no association, no banked time.
    const { sent, init, respond } = mount({ slot: 'background', granted });
    init();

    // A focus that is genuinely running, so stopping it has something to abandon.
    const running = { ...endedState('focus'), endsAt: Date.now() + 20 * 60 * 1000, asking: '' };
    respond(lastStateRead(sent).id, { value: JSON.stringify(running) });

    // Wait for the tick to ask for a command, then answer it the way the view would have left it.
    const deadline = Date.now() + 3000;
    let poll = null;
    while (!poll && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      poll = allOf(sent, 'share.get')
        .filter((m) => m.payload.name === 'command')
        .at(-1);
    }
    expect(poll, 'the timer never polled for a command - that is the bug this test is for').toBeTruthy();

    const before = allOf(sent, 'storage.set').filter((m) => m.payload.key === STATE_KEY).length;
    respond(poll.id, { value: JSON.stringify({ op: 'stop' }) });
    await new Promise((r) => setTimeout(r, 200));

    const writes = allOf(sent, 'storage.set').filter((m) => m.payload.key === STATE_KEY);
    expect(writes.length, '停止 did not persist anything').toBeGreaterThan(before);
    const after = JSON.parse(writes.at(-1).payload.value);
    // Back to 待开始: no phase, and no banked remainder to resume into.
    expect(after.phase).toBe('idle');
    expect(after.remainingOnHalt).toBe(0);
    expect(after.runState).toBe('stopped');
  });

  test('the record id is derived from the end moment, so a refire cannot duplicate it', async () => {
    const endedAt = 1_700_000_000_000;
    const { sent, init, respond } = mount({ slot: 'background', granted });
    init();
    respond(lastStateRead(sent).id, { value: JSON.stringify(endedState('focus', endedAt)) });
    sent.length = 0;

    await new Promise((r) => setTimeout(r, 1200));

    const recWrite = allOf(sent, 'storage.set').find((m) => m.payload.key === RECORDS_KEY);
    expect(recWrite, 'no record was written for a finished focus').toBeTruthy();
    const records = JSON.parse(recWrite.payload.value);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(`rec-${endedAt}`);
  });
});

describe('pomodoro 2.2.0: the records, and the control center', () => {
  // Two things arrived in 2.2.0, and both are about the same gap: the records were WRITTEN and
  // never read anywhere (the surface beside the pet is a countdown), and the control center's
  // 插件 page mounts this same document in a window where NO TIMER RUNS.
  const recordsRead = (sent) =>
    allOf(sent, 'storage.get').filter((m) => m.payload.key === RECORDS_KEY).at(-1);

  test('the settings the machine reads are all DECLARED, so the page can offer them', () => {
    // The plugin had no `config` at all: machine.js fell back to 25/5/15/4 for ever and the
    // 插件 page had no 设置 button to show. Declaring a key the machine does not read would be
    // the opposite bug (a switch that does nothing), so the two lists are compared.
    const declared = (manifest.config || []).map((c) => c.key).sort();
    const readByMachine = ['autoStartNextPhase', 'focusMinutes', 'longBreakEvery',
      'longBreakMinutes', 'shortBreakMinutes'].sort();
    // 2.3.0 added `showCountdown`, which the MACHINE does not read - it is the page's own setting
    // (draw the countdown on the pet via `pet.badge`). The assertion's point is unchanged: nothing
    // is declared that nothing reads, so the page's keys are listed here too rather than being
    // dropped from the comparison.
    const readByPage = ['showCountdown'];
    expect(declared).toEqual([...readByMachine, ...readByPage].sort());
    // And the defaults are the ones the machine already assumed: upgrading must not move a
    // running user's 25-minute session to something else.
    const def = Object.fromEntries((manifest.config || []).map((c) => [c.key, c.default]));
    expect(def.focusMinutes).toBe('25');
    expect(def.shortBreakMinutes).toBe('5');
    expect(def.longBreakMinutes).toBe('15');
    expect(def.longBreakEvery).toBe('4');
    // Off by default: a new thing drawn on the pet is opt-in, not something an update switches on.
    expect(def.showCountdown).toBe('false');
  });

  test('the view renders the sessions it reads, newest first', () => {
    const { window, sent, init, respond } = mount({ slot: '', granted });
    init();
    respond(lastStateRead(sent).id, { value: JSON.stringify({ enabled: true, phase: 'idle' }) });
    const read = recordsRead(sent);
    expect(read, 'the view never asked for the records').toBeTruthy();

    const rows = [
      { id: 'rec-1', endedAt: Date.UTC(2026, 9, 27, 6, 30), focusMinutes: 25, todoTitle: '写周报', summary: '第三节最难' },
      { id: 'rec-2', endedAt: Date.UTC(2026, 9, 28, 6, 30), focusMinutes: 50, todoTitle: '', summary: '' },
    ];
    respond(read.id, { value: JSON.stringify(rows) });

    const items = [...window.document.querySelectorAll('.record')];
    expect(items).toHaveLength(2);
    // Newest first: 10-28 before 10-27, whatever order storage answered in.
    expect(items[0].textContent).toContain('50 分钟');
    expect(items[1].textContent).toContain('25 分钟 · 写周报');
    expect(items[1].textContent).toContain('第三节最难');
    // The empty summary and the empty todo are simply absent, not blank cells.
    expect(items[0].querySelector('.record-note')).toBeNull();
    expect(window.document.getElementById('records-empty').hidden).toBe(true);
  });

  test('an empty record list says so instead of showing an empty box', () => {
    const { window, sent, init, respond } = mount({ slot: '', granted });
    init();
    respond(recordsRead(sent).id, { value: '[]' });
    expect(window.document.querySelectorAll('.record')).toHaveLength(0);
    expect(window.document.getElementById('records-empty').hidden).toBe(false);
  });

  test('in the control center the timer controls are HIDDEN, not dead', () => {
    // The workshop mount is the control center's 插件 page: no timer frame runs there, so a
    // 开始/暂停 that publishes a command nobody reads would be a button that lies. It is hidden,
    // and one line says where the timer actually is.
    const { window, init } = mount({ slot: 'workshop', kind: 'panel', granted });
    init();
    expect(window.document.getElementById('compose').hidden).toBe(true);
    expect(window.document.getElementById('elsewhere').hidden).toBe(false);
    expect(window.document.getElementById('elsewhere').textContent).toContain('计时在桌宠上');
    // The records are still there: that is what this window is for.
    expect(window.document.getElementById('records').hidden).toBe(false);
    expect(window.document.getElementById('root').className).toBe('view-workshop');
  });

  test('the pet surface keeps its controls', () => {
    const { window, init } = mount({ slot: 'pomodoro', kind: 'surface', granted });
    init();
    expect(window.document.getElementById('compose').hidden).toBe(false);
    expect(window.document.getElementById('elsewhere').hidden).toBe(true);
  });
});

describe('pomodoro 2.1.0: the view frame', () => {
  test('it never writes state', async () => {
    const { sent, init, respond } = mount({ slot: '', granted });
    init();
    respond(lastStateRead(sent).id, {
      value: JSON.stringify({ enabled: true, phase: 'idle', asking: '' }),
    });
    sent.length = 0;

    await new Promise((r) => setTimeout(r, 1200));

    expect(allOf(sent, 'storage.set')).toEqual([]);
  });

  test('a button press leaves a command, not a state write', () => {
    const { window, sent, init, respond } = mount({ slot: '', granted });
    init();
    respond(lastStateRead(sent).id, {
      value: JSON.stringify({ enabled: true, phase: 'idle', runState: 'stopped', asking: '' }),
    });
    sent.length = 0;

    window.document
      .getElementById('start')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const cmd = lastOf(sent, 'share.set');
    expect(cmd, 'a click did not publish a command').toBeTruthy();
    expect(cmd.payload.name).toBe('command');
    expect(JSON.parse(cmd.payload.value).op).toBe('start');
    // The one-writer rule: no state write from this frame, ever.
    expect(allOf(sent, 'storage.set')).toEqual([]);
  });

  test('the gate is read from the state, so a closed surface does not lose the question', () => {
    // `granted` is required here as in every other case: an ungranted view issues no reads at all,
    // which is correct behaviour and would make this test vacuous rather than failing.
    const { window, sent, init, respond } = mount({ slot: '', granted });
    init();
    respond(lastStateRead(sent).id, {
      value: JSON.stringify({
        enabled: true,
        phase: 'shortBreak',
        runState: 'stopped',
        asking: 'summary',
      }),
    });
    // The gate panel is up even though this frame never saw the phase end: the question was
    // persisted by the timer, and this document is showing it for the first time.
    expect(window.document.getElementById('ask').hidden).toBe(false);
    expect(window.document.getElementById('ask-label').textContent).toBe('这一段专注写点什么？');
  });
});

describe('pomodoro 2.3.1: the countdown on the pet', () => {
  // THE BUG THIS PINS. 2.3.0 built its settings object key by key and forgot `showCountdown`, and
  // the comparison it did use was `=== true` while the value arrives as the STRING "true". Either
  // mistake alone was enough: the badge was pushed as "" for ever. Nothing failed - the host logged
  // `pet.badge ok（payload 11 B → 11 B）` (11 bytes is `{"text":""}`) and the pet stayed bare. The
  // user found it, so the assertion here is about the TEXT, not about the call happening.
  test('a running focus pushes the remaining time, from the STRING setting', async () => {
    const { sent, init, respond } = mount({ slot: 'background', granted });
    init();

    const cfgRead = allOf(sent, 'config.get').at(-1);
    expect(cfgRead, 'the timer never read its settings').toBeTruthy();
    // Deliberately the string form: that is what the manifest declares and what the store returns.
    respond(cfgRead.id, { values: { showCountdown: 'true', focusMinutes: '5' } });

    const running = { ...endedState('focus'), endsAt: Date.now() + 5 * 60 * 1000, asking: '' };
    respond(lastStateRead(sent).id, { value: JSON.stringify(running) });

    const deadline = Date.now() + 3000;
    let badge = null;
    while (!badge && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      badge = allOf(sent, 'pet.badge').at(-1);
    }
    expect(badge, 'nothing was pushed for the pet while a focus was running').toBeTruthy();
    expect(badge.payload.text, 'the badge text was empty - the setting did not reach the page').toMatch(/^\d{2}:\d{2}$/);
  });

  test('switched off, it clears the line instead of drawing a countdown', async () => {
    const { sent, init, respond } = mount({ slot: 'background', granted });
    init();
    respond(allOf(sent, 'config.get').at(-1).id, { values: { showCountdown: 'false' } });
    const running = { ...endedState('focus'), endsAt: Date.now() + 5 * 60 * 1000, asking: '' };
    respond(lastStateRead(sent).id, { value: JSON.stringify(running) });

    await new Promise((r) => setTimeout(r, 1500));
    for (const m of allOf(sent, 'pet.badge')) {
      expect(m.payload.text, 'a switched-off countdown drew something').toBe('');
    }
  });
});