// The pomodoro state machine, ported from the host's `internal/pomodoro/machine.go`.
//
// It is PURE: transitions over (state, config, now) that report what happened instead of doing it.
// Nothing here touches a clock, a store or the DOM. Everything a transition can produce that has an
// external effect - a record to archive, a phase that ended, a question that should be asked - is
// returned in the outcome, and the caller decides what to do with it. That is what makes the whole
// machine testable without a window, which is exactly how the Go version was tested too
// (`market/tests/plugin-pomodoro-machine.test.js` is the port of that suite).
//
// The rules it encodes, and why each one is the way it is, are in the doc comment of each
// transition. They are not restated here: this file is a translation, and the reasoning lives where
// it was written (docs/reminder-pomodoro.md).

export const PHASE_IDLE = 'idle';
export const PHASE_FOCUS = 'focus';
export const PHASE_SHORT_BREAK = 'shortBreak';
export const PHASE_LONG_BREAK = 'longBreak';

export const RUN_RUNNING = 'running';
export const RUN_PAUSED = 'paused';
export const RUN_STOPPED = 'stopped';

const MIN_LONG_BREAK_EVERY = 2;
const DEFAULT_LONG_BREAK_EVERY = 4;

// How far past its own length a phase's end time may sit before the countdown is treated as
// nonsense. A running phase can never legitimately have more time left than the phase is long; if
// it does, the clock was moved backwards, and displaying an hour-long focus session is worse than
// abandoning it.
const CLOCK_JUMP_SLACK_MS = 2 * 60 * 1000;

/** True for the two rest phases. */
export function isBreakPhase(phase) {
  return phase === PHASE_SHORT_BREAK || phase === PHASE_LONG_BREAK;
}

/** A fresh state. The plugin starts from this when it has nothing stored. */
export function emptyState() {
  return {
    enabled: false,
    phase: PHASE_IDLE,
    runState: RUN_STOPPED,
    endsAt: 0, // Unix ms, 0 = nothing counting down
    phaseStartedAt: 0,
    remainingOnHalt: 0, // whole seconds banked when the countdown halted
    currentTodoId: '',
    currentTodoTitle: '',
    nextTodoId: '',
    nextTodoTitle: '',
    completedCount: 0,
    pendingRecordId: '',
    planPending: false,
  };
}

function copy(st) {
  return { ...emptyState(), ...st };
}

/** How long a phase lasts, in ms, from the user's config. */
export function phaseDurationMs(cfg, phase) {
  const minutes =
    phase === PHASE_FOCUS
      ? Number(cfg.focusMinutes)
      : phase === PHASE_LONG_BREAK
        ? Number(cfg.longBreakMinutes)
        : Number(cfg.shortBreakMinutes);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 25;
  return safe * 60 * 1000;
}

function longBreakEvery(cfg) {
  const n = Number(cfg.longBreakEvery);
  if (!Number.isFinite(n) || n < MIN_LONG_BREAK_EVERY) return DEFAULT_LONG_BREAK_EVERY;
  return Math.floor(n);
}

export function isRunning(st) {
  return st.runState === RUN_RUNNING && Number(st.endsAt) > 0;
}

/** How long is left in the current phase, in ms. */
export function remainingMs(st, now) {
  if (st.phase === PHASE_IDLE) return 0;
  if (isRunning(st)) {
    const d = Number(st.endsAt) - now;
    return d > 0 ? d : 0;
  }
  return (Number(st.remainingOnHalt) || 0) * 1000;
}

/** Rounds up to whole seconds, so a countdown never shows 00:00 while time remains. */
export function ceilSeconds(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.ceil(ms / 1000);
}

/** "MM:SS". Minutes are not capped at 99: a 120-minute phase reads 120:00. */
export function formatSeconds(secs) {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function formatCountdown(ms) {
  return formatSeconds(ceilSeconds(ms));
}

export function phaseLabel(phase) {
  if (phase === PHASE_FOCUS) return '专注';
  if (phase === PHASE_SHORT_BREAK) return '短休息';
  if (phase === PHASE_LONG_BREAK) return '长休息';
  return '空闲';
}

/** Begins a focus phase. An empty todo is allowed: nobody should be locked out of focusing. */
export function startFocus(st0, cfg, todoId, todoTitle, now) {
  const st = copy(st0);
  st.enabled = true;
  st.phase = PHASE_FOCUS;
  st.runState = RUN_RUNNING;
  st.endsAt = now + phaseDurationMs(cfg, PHASE_FOCUS);
  st.phaseStartedAt = now;
  st.remainingOnHalt = 0;
  st.currentTodoId = todoId || '';
  st.currentTodoTitle = todoTitle || '';
  return { state: st, nextPhase: PHASE_FOCUS };
}

/** Halts the countdown, keeping the remainder. A paused pomodoro is NOT a focusing one. */
export function pause(st0, now) {
  const st = copy(st0);
  if (!isRunning(st)) return { state: st };
  st.remainingOnHalt = Math.floor(remainingMs(st, now) / 1000);
  st.endsAt = 0;
  st.runState = RUN_PAUSED;
  return { state: st };
}

/** Restarts a paused or stopped phase from where it stopped. */
export function resume(st0, cfg, now) {
  const st = copy(st0);
  if (st.phase === PHASE_IDLE || st.runState === RUN_RUNNING) return { state: st };
  let remaining = (Number(st.remainingOnHalt) || 0) * 1000;
  if (remaining <= 0) {
    // Nothing was banked (a state written by an older build, say): a full phase beats resuming a
    // zero-length one that would end instantly.
    remaining = phaseDurationMs(cfg, st.phase);
  }
  st.endsAt = now + remaining;
  st.runState = RUN_RUNNING;
  st.remainingOnHalt = 0;
  if (!st.phaseStartedAt) st.phaseStartedAt = now;
  return { state: st, nextPhase: st.phase };
}

/** Halts like pause, but records that the user asked for it. Recoverable: resume picks it back up. */
export function stop(st0, now) {
  const out = pause(st0, now);
  if (out.state.phase === PHASE_IDLE) return out;
  out.state.runState = RUN_STOPPED;
  return out;
}

/**
 * Abandons everything: no phase, no association, no banked time.
 *
 * `completedCount` survives - the long-break cadence is a property of the day, not of the current
 * session - and so does `enabled`.
 */
export function reset(st0) {
  const st = emptyState();
  st.enabled = st0.enabled;
  st.completedCount = st0.completedCount;
  return { state: st };
}

function nextPhaseAfter(st, cfg) {
  if (st.phase !== PHASE_FOCUS) return PHASE_FOCUS;
  const every = longBreakEvery(cfg);
  if (st.completedCount > 0 && st.completedCount % every === 0) return PHASE_LONG_BREAK;
  return PHASE_SHORT_BREAK;
}

/**
 * Ends the current phase and moves to the next one.
 *
 * `endedAt` is when the phase actually ran out; `now` is the wall clock at the moment it is being
 * processed. They differ exactly when the pet was not running, and keeping them apart is what stops
 * a catch-up from cascading: the record uses `endedAt` (so it is not stretched by the absence), the
 * next phase starts at `now` (so it does not expire the instant it begins).
 *
 * A finished FOCUS always produces a record, and the move to the rest is GATED on that record being
 * answered: the state is left PARKED (stopped, with the next phase's full length banked) whatever
 * `autoStartNextPhase` says. The caller sets `pendingRecordId` from the returned record.
 */
export function finishPhase(st0, cfg, endedAt, now, missed) {
  const st = copy(st0);
  if (st.phase === PHASE_IDLE) return { state: st };

  const ended = st.phase;
  const out = { endedPhase: ended, missed: missed === true };
  const duration = phaseDurationMs(cfg, ended);

  if (ended === PHASE_FOCUS) {
    st.completedCount += 1;
    const started = st.phaseStartedAt || endedAt - duration;
    out.record = {
      todoId: st.currentTodoId || '',
      todoTitle: st.currentTodoTitle || '',
      startedAt: started,
      endedAt,
      focusMinutes: Number(cfg.focusMinutes) || 25,
    };
    // The session that just ended is the one that knows what it was about, so its association is
    // carried forward for the NEXT focus to offer back. The current association is cleared below:
    // the todo belongs to the finished session, not to the break.
    st.nextTodoId = st.currentTodoId || '';
    st.nextTodoTitle = st.currentTodoTitle || '';
  }

  const next = nextPhaseAfter(st, cfg);
  out.nextPhase = next;
  st.phase = next;
  st.currentTodoId = '';
  st.currentTodoTitle = '';
  st.phaseStartedAt = 0;
  st.endsAt = 0;

  if (ended === PHASE_FOCUS) {
    st.runState = RUN_STOPPED;
    st.remainingOnHalt = Math.floor(phaseDurationMs(cfg, next) / 1000);
    out.state = st;
    return out;
  }

  if (cfg.autoStartNextPhase) {
    st.runState = RUN_RUNNING;
    st.endsAt = now + phaseDurationMs(cfg, next);
    st.phaseStartedAt = now;
    st.remainingOnHalt = 0;
  } else {
    st.runState = RUN_STOPPED;
    st.remainingOnHalt = Math.floor(phaseDurationMs(cfg, next) / 1000);
  }

  out.state = st;
  return out;
}

/**
 * Abandons the current phase without recording it.
 *
 * A skipped FOCUS still counts for the long-break cadence - otherwise a user who skips would never
 * reach a long break - but produces no record, which is the single way to leave a session out of
 * the archive (hence the UI asks first). The plan question and the carried todo go too: a gate left
 * behind here would be one nobody could answer.
 */
export function skipPhase(st0, cfg, now) {
  const st = copy(st0);
  if (st.phase === PHASE_IDLE) return { state: st };

  const ended = st.phase;
  if (ended === PHASE_FOCUS) st.completedCount += 1;

  const next = nextPhaseAfter(st, cfg);
  st.phase = next;
  st.runState = RUN_RUNNING;
  st.endsAt = now + phaseDurationMs(cfg, next);
  st.phaseStartedAt = now;
  st.remainingOnHalt = 0;
  st.currentTodoId = '';
  st.currentTodoTitle = '';
  st.planPending = false;
  st.nextTodoId = '';
  st.nextTodoTitle = '';
  return { state: st, endedPhase: ended, nextPhase: next };
}

/**
 * Whether a transition must stop and ask what the next focus session is about.
 *
 * Only a finished BREAK leading into a focus asks, and only when it is processed in real time (not
 * a catch-up on launch) and not under a full-screen window - each refusal is a different kind of
 * "the user is not here to answer".
 */
export function shouldAskPlan(out, restored, fullscreen) {
  if (restored || fullscreen) return false;
  return (
    !!out &&
    !!out.endedPhase &&
    isBreakPhase(out.endedPhase) &&
    out.nextPhase === PHASE_FOCUS
  );
}

/**
 * Repairs a state loaded from storage, and decides whether a phase ran out while the pet was not
 * running. This is what makes closing the pet mid-focus harmless: the end time is absolute.
 */
export function reconcile(st0, cfg, now) {
  const st = copy(st0);
  if (!st.enabled || !isRunning(st)) return { state: st };

  const remaining = Number(st.endsAt) - now;
  const duration = phaseDurationMs(cfg, st.phase);
  if (remaining > duration + CLOCK_JUMP_SLACK_MS) {
    const out = reset(st);
    out.clockJump = true;
    out.endedPhase = st.phase;
    return out;
  }
  if (remaining > 0) return { state: st };
  // The phase ended at `endsAt`, not at "now": using now would credit the absence to the NEXT phase
  // and stretch every record.
  return finishPhase(st, cfg, Number(st.endsAt), now, true);
}

/** Whether a finished focus session is still waiting for its summary. */
export function hasPendingSummary(st) {
  return !!st.pendingRecordId;
}
