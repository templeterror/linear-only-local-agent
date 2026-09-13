// Wrapper around `claude -p` (Claude Code headless) with structured output.
import { run } from './proc.ts';
import { log } from './log.ts';

export interface ClaudeCallOpts {
  prompt: string;
  cwd: string;
  schema?: object;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs: number;
  resume?: string;
  appendSystemPrompt?: string;
}

export interface ClaudeResult<T> {
  ok: boolean;
  output?: T;
  text: string;
  sessionId?: string;
  costUsd?: number;
  error?: string;
  subtype?: string;
}

/** Read-only tool set used by planner and verifier. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git show:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(wc:*)'];
export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** Failures worth one more attempt: the model produced output the schema rejected, or no structured output at all. */
const RETRYABLE = /error_max_structured_output_retries|no structured_output|without JSON result/;

export async function callClaude<T = unknown>(opts: ClaudeCallOpts & { retries?: number }): Promise<ClaudeResult<T>> {
  const attempts = 1 + (opts.retries ?? 1);
  let last: ClaudeResult<T> | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await callClaudeOnce<T>(opts);
    if (last.ok || !RETRYABLE.test(last.error ?? '')) return last;
    log('claude', `retrying (${i + 1}/${attempts - 1}) after: ${last.error?.slice(0, 120)}`);
  }
  return last!;
}

async function callClaudeOnce<T = unknown>(opts: ClaudeCallOpts): Promise<ClaudeResult<T>> {
  const args = ['-p', '--output-format', 'json'];
  if (opts.schema) args.push('--json-schema', JSON.stringify(opts.schema));
  if (opts.model) args.push('--model', opts.model);
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.disallowedTools?.length) args.push('--disallowedTools', opts.disallowedTools.join(','));
  if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));
  // Only for API-key billing. On a subscription nothing is billed per token, so no cap is passed.
  if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);

  // Never inherit a parent Claude Code session's identity into the child.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const started = Date.now();
  const r = await run('claude', args, { cwd: opts.cwd, env, input: opts.prompt, timeoutMs: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const dur = ((Date.now() - started) / 1000).toFixed(0);

  if (r.timedOut) return { ok: false, text: r.stdout, error: `claude timed out after ${dur}s` };

  const parsed = parseResultJson(r.stdout);
  if (!parsed) {
    return { ok: false, text: r.stdout, error: `claude exited ${r.code} without JSON result: ${(r.stderr || r.stdout).trim().slice(0, 400)}` };
  }
  const sessionId = parsed.session_id as string | undefined;
  const costUsd = parsed.total_cost_usd as number | undefined;
  // total_cost_usd is Claude Code's API-equivalent estimate — informational only on a subscription.
  log('claude', `done in ${dur}s subtype=${parsed.subtype} est=$${costUsd?.toFixed(3) ?? '?'} session=${sessionId ?? '?'}`);

  if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
    return { ok: false, text: String(parsed.result ?? ''), sessionId, costUsd, subtype: parsed.subtype, error: `claude ${parsed.subtype ?? 'error'}: ${String(parsed.result ?? '').slice(0, 400)}` };
  }
  let output: T | undefined = parsed.structured_output as T | undefined;
  if (output === undefined && opts.schema) {
    // Fall back: model may have emitted JSON as text.
    try {
      output = JSON.parse(String(parsed.result)) as T;
    } catch {
      return { ok: false, text: String(parsed.result ?? ''), sessionId, costUsd, error: 'claude returned no structured_output' };
    }
  }
  return { ok: true, output, text: String(parsed.result ?? ''), sessionId, costUsd, subtype: parsed.subtype };
}

function parseResultJson(stdout: string): any | null {
  const s = stdout.trim();
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.find((x) => x?.type === 'result') ?? null;
    return j;
  } catch {
    /* fallthrough */
  }
  // Find the last line that parses as a result object.
  const lines = s.split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (j.type === 'result') return j;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
