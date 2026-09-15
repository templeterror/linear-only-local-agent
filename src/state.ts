// Job state machine. Pure data + one assertion helper; no I/O.

export const STATES = [
  'queued',
  'triaging',
  'waiting_on_human',
  'planning',
  'building',
  'testing',
  'verifying',
  'awaiting_approval',
  'pr_open',
  'failed',
  'declined',
] as const;

export type State = (typeof STATES)[number];

/** States where the daemon actively runs a step. */
export const ACTIVE_STATES: readonly State[] = ['queued', 'triaging', 'planning', 'building', 'testing', 'verifying'];
/** States where the daemon waits for a human comment on the Linear issue. */
export const IDLE_STATES: readonly State[] = ['waiting_on_human', 'awaiting_approval'];
/** No further daemon action. */
export const TERMINAL_STATES: readonly State[] = ['pr_open', 'failed', 'declined'];

export const TRANSITIONS: Record<State, readonly State[]> = {
  queued: ['triaging'],
  triaging: ['planning', 'waiting_on_human', 'declined'],
  waiting_on_human: ['planning', 'waiting_on_human', 'declined'],
  planning: ['building'],
  building: ['testing', 'awaiting_approval'], // → awaiting_approval only when a human's change request produced no changes
  testing: ['verifying'],
  verifying: ['awaiting_approval', 'pr_open', 'building'],
  awaiting_approval: ['pr_open', 'building'],
  pr_open: [],
  failed: [],
  declined: [],
};

/** Any non-terminal state may abort into failed/declined. */
const ABORT_TARGETS: readonly State[] = ['failed', 'declined'];

export function isState(s: string): s is State {
  return (STATES as readonly string[]).includes(s);
}

export function canTransition(from: State, to: State): boolean {
  if (TRANSITIONS[from].includes(to)) return true;
  if (ABORT_TARGETS.includes(to) && !TERMINAL_STATES.includes(from)) return true;
  return false;
}

export function assertTransition(from: State, to: State): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal state transition ${from} -> ${to}`);
  }
}
