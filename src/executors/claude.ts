// Claude Code as a drop-in second worker. Same interface as the Cursor executor.
import { callClaude, detectUsageLimit } from '../claude-cli.ts';
import { stageAndDiff } from '../git.ts';
import type { Executor, ExecutorInput, ExecutorResult } from './types.ts';

const WORKER_TOOLS = [
  'Edit',
  'Write',
  'MultiEdit',
  'Read',
  'Grep',
  'Glob',
  'LS',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(pnpm:*)',
  'Bash(yarn:*)',
  'Bash(bun:*)',
  'Bash(bunx:*)',
  'Bash(node:*)',
  'Bash(python:*)',
  'Bash(pytest:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(mkdir:*)',
];

export const claudeExecutor: Executor = {
  kind: 'claude',
  async run(input: ExecutorInput): Promise<ExecutorResult> {
    const res = await callClaude<unknown>({
      prompt: input.prompt,
      cwd: input.worktree,
      model: input.model || undefined,
      allowedTools: WORKER_TOOLS,
      disallowedTools: ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git checkout:*)', 'Bash(git reset:*)', 'Bash(rm -rf:*)'],
      maxTurns: 150,
      timeoutMs: input.timeoutMs,
      resume: input.resumeId,
    });
    const staged = await stageAndDiff(input.worktree);
    const limit = res.limit ?? (staged.files.length === 0 ? detectUsageLimit(res.text) : null) ?? undefined;
    if (limit) return { ok: false, summary: res.text, sessionId: res.sessionId, error: `worker usage limit: ${limit.message}`, limit, ...staged };
    if (!res.ok && !staged.files.length) return { ok: false, summary: res.text, sessionId: res.sessionId, error: res.error, ...staged };
    return { ok: true, summary: res.text, sessionId: res.sessionId, ...staged };
  },
};
