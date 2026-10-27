import { describe, expect, test } from 'vitest';
import * as m from '../plugins/com.shixiansi.plugin-pomodoro/machine.js';

// The host's timer state machine was tested by `internal/pomodoro/machine_test.go`; this is the
// port's equivalent, written against the SAME rules (the Go comments are the spec). It runs here
// because the machine now lives in the plugin - the host's copy is on its way out
// (openspec/changes/todo-pomodoro-as-plugins, stage 2).
//
// The transitions are pure functions over (state, config, now), so every case is a plain call with
// a fixed instant. No clock, no window, no store.

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000; // an arbitrary fixed instant

const cfg = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
  autoStartNextPhase: true,
};

/** A running focus session that started 1 minute ago. */
function focusing(extra = {}) {
  return {
    ...m.emptyState(),
    ...m.startFocus(m.emptyState(), cfg, 'todo-1', '写周报', NOW - MIN).state,
    ...extra,
  };
}

describe('start / pause / resume / stop', () => {
  test('starting a focus phase runs it for the configured length, attached to the todo', () => {
    const st = m.startFocus(m.emptyState(), cfg, 'todo-1', '写周报', NOW).state;
    expect(st.enabled).toBe(true);
    expect(st.phase).toBe(m.PHASE_FOCUS);
    expect(st.runState).toBe(m.RUN_RUNNING);
    expect(st.endsAt).toBe(NOW + 25 * MIN);
    expect(st.currentTodoId).toBe('todo-1');
    expect(st.currentTodoTitle).toBe('写周报');
  });

  test('a focus session may be unattached: nobody is locked out of focusing', () => {
    const st = m.startFocus(m.emptyState(), cfg, '', '', NOW).state;
    expect(st.phase).toBe(m.PHASE_FOCUS);
    expect(st.currentTodoId).toBe('');
  });

  test('pausing banks the remainder and stops the countdown', () => {
    const st = m.pause(focusing(), NOW).state;
    expect(st.runState).toBe(m.RUN_PAUSED);
    expect(st.endsAt).toBe(0);
    // 24 minutes left after one minute of focus.
    expect(st.remainingOnHalt).toBe(24 * 60);
  });

  test('resuming continues from the banked remainder, not from a full phase', () => {
    const paused = m.pause(focusing(), NOW).state;
    const st = m.resume(paused, cfg, NOW + 10 * MIN).state;
    expect(st.runState).toBe(m.RUN_RUNNING);
    expect(st.endsAt).toBe(NOW + 10 * MIN + 24 * MIN);
  });

  test('a state with nothing banked resumes as a full phase rather than a zero-length one', () => {
    const broken = { ...m.emptyState(), phase: m.PHASE_FOCUS, runState: m.RUN_PAUSED, remainingOnHalt: 0 };
    const st = m.resume(broken, cfg, NOW).state;
    expect(st.endsAt).toBe(NOW + 25 * MIN);
  });

  test('stop is a pause the user asked for: recoverable, not a discard', () => {
    const st = m.stop(focusing(), NOW).state;
    expect(st.runState).toBe(m.RUN_STOPPED);
    expect(st.remainingOnHalt).toBe(24 * 60);
    // ...and resume still picks it back up.
    expect(m.resume(st, cfg, NOW).state.runState).toBe(m.RUN_RUNNING);
  });

  test('reset abandons the session but keeps the day’s completed count', () => {
    const st = m.reset({ ...focusing(), completedCount: 3 }).state;
    expect(st.phase).toBe(m.PHASE_IDLE);
    expect(st.currentTodoId).toBe('');
    expect(st.completedCount).toBe(3);
  });
});

describe('finishing a phase', () => {
  test('a finished focus banks a record and PARKS the break, whatever autoStart says', () => {
    const st = focusing();
    const out = m.finishPhase(st, cfg, NOW, NOW, false);

    expect(out.endedPhase).toBe(m.PHASE_FOCUS);
    expect(out.nextPhase).toBe(m.PHASE_SHORT_BREAK);
    expect(out.record).toBeTruthy();
    expect(out.record.todoTitle).toBe('写周报');
    expect(out.record.endedAt).toBe(NOW);

    // The gate: the rest is in place but STOPPED with its full length banked, so the break cannot
    // run while the summary is unanswered.
    expect(out.state.phase).toBe(m.PHASE_SHORT_BREAK);
    expect(out.state.runState).toBe(m.RUN_STOPPED);
    expect(out.state.remainingOnHalt).toBe(5 * 60);
    expect(out.state.completedCount).toBe(1);
    // The association moves forward for the next focus to offer back.
    expect(out.state.nextTodoId).toBe('todo-1');
    expect(out.state.currentTodoId).toBe('');
  });

  test('the long break arrives on the configured cadence', () => {
    const st = { ...focusing(), completedCount: 3 }; // the 4th focus is finishing
    const out = m.finishPhase(st, cfg, NOW, NOW, false);
    expect(out.nextPhase).toBe(m.PHASE_LONG_BREAK);
    expect(out.state.remainingOnHalt).toBe(15 * 60);
  });

  test('a finished break runs straight into the next focus when autoStart is on', () => {
    const st = { ...m.emptyState(), phase: m.PHASE_SHORT_BREAK, runState: m.RUN_RUNNING, endsAt: NOW };
    const out = m.finishPhase(st, cfg, NOW, NOW, false);
    expect(out.endedPhase).toBe(m.PHASE_SHORT_BREAK);
    expect(out.nextPhase).toBe(m.PHASE_FOCUS);
    expect(out.record).toBeUndefined(); // only a focus makes a record
    expect(out.state.runState).toBe(m.RUN_RUNNING);
    expect(out.state.endsAt).toBe(NOW + 25 * MIN);
  });

  test('with autoStart off the next phase waits, banked in full', () => {
    const st = { ...m.emptyState(), phase: m.PHASE_SHORT_BREAK, runState: m.RUN_RUNNING, endsAt: NOW };
    const out = m.finishPhase(st, { ...cfg, autoStartNextPhase: false }, NOW, NOW, false);
    expect(out.state.runState).toBe(m.RUN_STOPPED);
    expect(out.state.remainingOnHalt).toBe(25 * 60);
  });

  test('a catch-up keeps endedAt apart from now, so records are not stretched', () => {
    // The phase ended at 11:35 and is being processed at 14:00 (the pet was closed).
    const endedAt = NOW;
    const now = NOW + 145 * MIN;
    const st = { ...focusing(), endsAt: endedAt };
    const out = m.finishPhase(st, cfg, endedAt, now, true);

    expect(out.missed).toBe(true);
    expect(out.record.endedAt).toBe(endedAt);
    // The NEXT phase starts at `now`, not at `endedAt` - otherwise it would expire instantly.
    expect(out.state.runState).toBe(m.RUN_STOPPED);
    expect(out.state.endsAt).toBe(0);
  });

  test('skipping a focus counts for the cadence but writes no record', () => {
    const out = m.skipPhase(focusing(), cfg, NOW);
    expect(out.endedPhase).toBe(m.PHASE_FOCUS);
    expect(out.record).toBeUndefined();
    expect(out.state.completedCount).toBe(1);
    expect(out.state.runState).toBe(m.RUN_RUNNING);
    expect(out.state.endsAt).toBe(NOW + 5 * MIN);
    // A gate left behind here would be one nobody could answer.
    expect(out.state.planPending).toBe(false);
    expect(out.state.nextTodoId).toBe('');
  });
});

describe('reconcile (a state loaded from storage)', () => {
  test('a phase that ran out while the pet was closed is completed, not restarted', () => {
    const st = { ...focusing(), endsAt: NOW - MIN }; // ran out a minute ago
    const out = m.reconcile(st, cfg, NOW);
    expect(out.endedPhase).toBe(m.PHASE_FOCUS);
    expect(out.missed).toBe(true);
    expect(out.record).toBeTruthy();
    expect(out.record.endedAt).toBe(NOW - MIN);
  });

  test('a phase still counting down is left alone', () => {
    const st = focusing();
    const out = m.reconcile(st, cfg, NOW);
    expect(out.state.endsAt).toBe(st.endsAt);
    expect(out.endedPhase).toBeUndefined();
  });

  test('more time left than the phase is long means the clock moved backwards: abandon it', () => {
    const st = { ...focusing(), endsAt: NOW + 120 * MIN };
    const out = m.reconcile(st, cfg, NOW);
    expect(out.clockJump).toBe(true);
    expect(out.state.phase).toBe(m.PHASE_IDLE);
  });

  test('a stopped or paused state is not reconciled at all', () => {
    const st = m.stop(focusing(), NOW).state;
    const out = m.reconcile(st, cfg, NOW + 60 * MIN);
    expect(out.state.runState).toBe(m.RUN_STOPPED);
    expect(out.state.remainingOnHalt).toBe(st.remainingOnHalt);
  });
});

describe('the plan gate', () => {
  const breakEnded = { endedPhase: m.PHASE_SHORT_BREAK, nextPhase: m.PHASE_FOCUS };
  const focusEnded = { endedPhase: m.PHASE_FOCUS, nextPhase: m.PHASE_SHORT_BREAK };

  test('a finished break leading into a focus asks', () => {
    expect(m.shouldAskPlan(breakEnded, false, false)).toBe(true);
  });

  test('a finished focus does not ask - it is gated on its record instead', () => {
    expect(m.shouldAskPlan(focusEnded, false, false)).toBe(false);
  });

  test('a catch-up on launch does not ask: the question would be about a session long past', () => {
    expect(m.shouldAskPlan(breakEnded, true, false)).toBe(false);
  });

  test('a full-screen window does not ask, and does not ask later either', () => {
    expect(m.shouldAskPlan(breakEnded, false, true)).toBe(false);
  });
});

describe('the numbers on screen', () => {
  test('seconds round UP, so a countdown never shows 00:00 while time remains', () => {
    expect(m.ceilSeconds(1)).toBe(1);
    expect(m.ceilSeconds(999)).toBe(1);
    expect(m.ceilSeconds(1000)).toBe(1);
    expect(m.ceilSeconds(1001)).toBe(2);
    expect(m.ceilSeconds(0)).toBe(0);
  });

  test('MM:SS, with minutes uncapped', () => {
    expect(m.formatSeconds(0)).toBe('00:00');
    expect(m.formatSeconds(59)).toBe('00:59');
    expect(m.formatSeconds(60)).toBe('01:00');
    expect(m.formatSeconds(120 * 60)).toBe('120:00');
    expect(m.formatCountdown(25 * MIN)).toBe('25:00');
  });

  test('the label is what the face prints', () => {
    expect(m.phaseLabel(m.PHASE_FOCUS)).toBe('专注');
    expect(m.phaseLabel(m.PHASE_SHORT_BREAK)).toBe('短休息');
    expect(m.phaseLabel(m.PHASE_LONG_BREAK)).toBe('长休息');
    expect(m.phaseLabel(m.PHASE_IDLE)).toBe('空闲');
  });

  test('remaining is frozen at the halt when not running', () => {
    const paused = m.pause(focusing(), NOW).state;
    expect(m.remainingMs(paused, NOW + 60 * MIN)).toBe(24 * MIN);
  });
});
