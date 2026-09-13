import { cursorExecutor } from './cursor.ts';
import { claudeExecutor } from './claude.ts';
import type { Executor } from './types.ts';

export function getExecutor(kind: 'cursor' | 'claude'): Executor {
  return kind === 'claude' ? claudeExecutor : cursorExecutor;
}

export type { Executor, ExecutorInput, ExecutorResult } from './types.ts';
