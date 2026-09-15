// Verifier: separate `claude -p` call that grades the worker's diff + test output against the acceptance criteria.
import { callClaude, READ_ONLY_TOOLS, WRITE_TOOLS, type UsageLimit } from './claude-cli.ts';
import { VERIFY_SCHEMA, verifyPrompt, type TicketRef } from './prompts/index.ts';
import type { Project } from './registry.ts';
import type { Spec } from './planner.ts';

export interface CriterionResult {
  criterion: string;
  met: boolean;
  evidence: string;
}

export interface Verdict {
  verdict: 'pass' | 'fail';
  summary: string;
  criteria: CriterionResult[];
  fixInstructions: string;
}

export interface VerifierOutcome {
  ok: boolean;
  verdict?: Verdict;
  costUsd?: number;
  error?: string;
  limit?: UsageLimit;
}

export async function verify(opts: { project: Project; worktree: string; ticket: TicketRef; spec: Spec; testExit: number | null; testOutput: string; diff: string; diffStat: string }): Promise<VerifierOutcome> {
  const { project } = opts;
  const res = await callClaude<Verdict>({
    prompt: verifyPrompt({ ticket: opts.ticket, spec: opts.spec, testCommand: project.commands.test, testExit: opts.testExit, testOutput: opts.testOutput, diff: opts.diff, diffStat: opts.diffStat }),
    cwd: opts.worktree,
    schema: VERIFY_SCHEMA,
    model: project.verifier.model,
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: WRITE_TOOLS,
    maxTurns: 30,
    maxBudgetUsd: project.verifier.maxBudgetUsd,
    timeoutMs: project.verifier.timeoutMin * 60_000,
    appendSystemPrompt: 'You are a strict but fair code reviewer. You never edit files. Answer with the requested structured output only.',
  });
  if (!res.ok || !res.output) return { ok: false, error: res.error ?? 'verifier returned nothing', costUsd: res.costUsd, limit: res.limit };
  const v = res.output;
  if (v.verdict !== 'pass' && v.verdict !== 'fail') return { ok: false, error: `verifier bad verdict ${v.verdict}`, costUsd: res.costUsd };
  if (v.verdict === 'fail' && !v.fixInstructions?.trim()) v.fixInstructions = v.summary || 'Verifier failed the attempt without instructions; re-read the acceptance criteria and address every unmet one.';
  return { ok: true, verdict: { verdict: v.verdict, summary: v.summary ?? '', criteria: v.criteria ?? [], fixInstructions: v.fixInstructions ?? '' }, costUsd: res.costUsd };
}
