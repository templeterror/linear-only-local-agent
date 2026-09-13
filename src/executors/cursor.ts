// Cursor CLI headless worker: `cursor-agent -p --workspace <worktree>`.
import { run } from '../proc.ts';
import { stageAndDiff } from '../git.ts';
import { log } from '../log.ts';
import type { Executor, ExecutorInput, ExecutorResult } from './types.ts';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

export const cursorExecutor: Executor = {
  kind: 'cursor',
  async run(input: ExecutorInput): Promise<ExecutorResult> {
    const args = ['-p', '--output-format', 'json', '--force', '--approve-mcps', '--workspace', input.worktree];
    if (input.model) args.push('--model', input.model);
    if (input.resumeId) args.push('--resume', input.resumeId);
    args.push(input.prompt);

    const started = Date.now();
    const r = await run('cursor-agent', args, { cwd: input.worktree, timeoutMs: input.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    const dur = ((Date.now() - started) / 1000).toFixed(0);
    const out = stripAnsi(r.stdout);
    const parsed = parseCursorJson(out);
    const summary = parsed?.text ?? out.trim().slice(-4000);
    const sessionId = parsed?.sessionId;
    log('cursor', `done in ${dur}s exit=${r.code} timedOut=${r.timedOut} session=${sessionId ?? '?'}`);

    const staged = await stageAndDiff(input.worktree);
    if (r.timedOut) return { ok: false, summary, sessionId, error: `cursor-agent timed out after ${dur}s`, ...staged };
    if (r.code !== 0 && !staged.files.length) {
      return { ok: false, summary, sessionId, error: `cursor-agent exited ${r.code}: ${stripAnsi(r.stderr || out).trim().slice(0, 500)}`, ...staged };
    }
    return { ok: true, summary, sessionId, ...staged };
  },
};

/** cursor-agent JSON output shape is not documented; be defensive. */
function parseCursorJson(out: string): { text: string; sessionId?: string } | null {
  const objs: any[] = [];
  const t = out.trim();
  try {
    const j = JSON.parse(t);
    objs.push(...(Array.isArray(j) ? j : [j]));
  } catch {
    for (const line of t.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try {
        objs.push(JSON.parse(l));
      } catch {
        /* skip */
      }
    }
  }
  if (!objs.length) return null;
  const pick = (o: any, keys: string[]) => keys.map((k) => o?.[k]).find((v) => typeof v === 'string' && v.length);
  const result = [...objs].reverse().find((o) => o?.type === 'result') ?? objs[objs.length - 1];
  const text = pick(result, ['result', 'text', 'content', 'message', 'output']) ?? '';
  const sessionId = objs.map((o) => pick(o, ['chat_id', 'chatId', 'session_id', 'sessionId', 'thread_id', 'threadId', 'id'])).find(Boolean);
  return { text: String(text), sessionId };
}
