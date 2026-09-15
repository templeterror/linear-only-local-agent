// One interface for every worker. The daemon only ever calls `run`.
export interface ExecutorInput {
  worktree: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  /** Continue a previous worker session (for verifier retries). */
  resumeId?: string;
}

import type { UsageLimit } from '../claude-cli.ts';

export interface ExecutorResult {
  ok: boolean;
  summary: string;
  sessionId?: string;
  error?: string;
  /** The worker's subscription usage limit was hit; the job should pause and retry later. */
  limit?: UsageLimit;
  /** Unified diff of everything the worker changed (staged by the executor). */
  diff: string;
  diffStat: string;
  files: string[];
}

export interface Executor {
  readonly kind: 'cursor' | 'claude';
  run(input: ExecutorInput): Promise<ExecutorResult>;
}
