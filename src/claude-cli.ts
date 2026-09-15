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
  /** Set when the call failed because the subscription's usage limit was hit; the job should pause, not fail. */
  limit?: UsageLimit;
}

export interface UsageLimit {
  message: string;
  /** When the limit resets, if the message said so; null → caller picks a default backoff. */
  retryAt: Date | null;
}

// Only the phrasings the CLIs actually use for a subscription cap. Deliberately no generic "rate limit" —
// a worker legitimately describing a rate-limited endpoint it built must not pause the job.
const LIMIT_RE = /(you'?ve hit your (session|usage|weekly|daily|monthly|5-hour) limit|hit your (session|usage) limit|usage limit (reached|exceeded)|you'?ve reached your (usage|session|weekly|daily) limit|out of (usage|credits))/i;

/**
 * Recognise a subscription usage-limit message in a CLI's text output (Claude Code or Cursor).
 * A real limit reply is a short message; anything long is model output that merely mentions limits.
 */
export function detectUsageLimit(text: string | undefined | null): UsageLimit | null {
  if (!text) return null;
  const t = text.trim();
  if (t.length > 500 || !LIMIT_RE.test(t)) return null;
  const line = t.split('\n').find((l) => LIMIT_RE.test(l)) ?? t;
  return { message: line.trim().slice(0, 200), retryAt: parseResetTime(t) };
}

/** "resets 5:20pm (America/New_York)" → the next moment that wall-clock time occurs in that zone. */
function parseResetTime(text: string): Date | null {
  const m = text.match(/resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z_]+\/[A-Za-z_+-]+)\))?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: m[4] || undefined, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
    const nowH = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
    const nowM = Number(parts.find((p) => p.type === 'minute')!.value);
    let delta = h * 60 + min - (nowH * 60 + nowM);
    if (delta < 0) delta += 24 * 60;
    return new Date(Date.now() + (delta + 1) * 60_000);
  } catch {
    return null;
  }
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

  // A subscription usage limit comes back as a "successful" text answer with no structured output.
  const limit = parsed.structured_output === undefined ? detectUsageLimit(String(parsed.result ?? '')) : null;
  if (limit) return { ok: false, text: String(parsed.result ?? ''), sessionId, costUsd, subtype: parsed.subtype, limit, error: `claude usage limit: ${limit.message}` };
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
