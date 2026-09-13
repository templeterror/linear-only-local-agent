// Planner: one `claude -p` session per ticket that triages and writes the spec.
// A clarification reply resumes the same session so repo context is retained.
import { callClaude, READ_ONLY_TOOLS, WRITE_TOOLS } from './claude-cli.ts';
import { TRIAGE_SCHEMA, triagePrompt, triageResumePrompt, type TicketRef } from './prompts/index.ts';
import type { Project } from './registry.ts';

export interface Spec {
  summary: string;
  steps: string[];
  acceptanceCriteria: string[];
  filesLikelyTouched: string[];
  previewRoute: string;
  needsMigration: boolean;
  testHints: string;
}

export interface TriageResult {
  decision: 'automatable' | 'needs_clarification' | 'out_of_scope';
  reason: string;
  question: string;
  spec: Spec;
}

export interface PlannerOutcome {
  ok: boolean;
  result?: TriageResult;
  sessionId?: string;
  costUsd?: number;
  error?: string;
}

const PLANNER_SYSTEM = 'You are a careful senior engineer acting as a planner. You never edit files. You answer with the requested structured output only.';

function normalize(r: TriageResult): TriageResult {
  const spec = r.spec ?? ({} as Spec);
  return {
    decision: r.decision,
    reason: r.reason ?? '',
    question: r.question ?? '',
    spec: {
      summary: spec.summary ?? '',
      steps: spec.steps ?? [],
      acceptanceCriteria: spec.acceptanceCriteria ?? [],
      filesLikelyTouched: spec.filesLikelyTouched ?? [],
      previewRoute: spec.previewRoute ?? '',
      needsMigration: !!spec.needsMigration,
      testHints: spec.testHints ?? '',
    },
  };
}

function validate(r: TriageResult): string | null {
  if (!['automatable', 'needs_clarification', 'out_of_scope'].includes(r.decision)) return `bad decision ${r.decision}`;
  if (r.decision === 'needs_clarification' && !r.question.trim()) return 'needs_clarification without a question';
  if (r.decision === 'automatable') {
    if (!r.spec.summary.trim()) return 'automatable without summary';
    if (r.spec.acceptanceCriteria.length < 1) return 'automatable without acceptance criteria';
  }
  return null;
}

export async function triage(project: Project, ticket: TicketRef): Promise<PlannerOutcome> {
  const res = await callClaude<TriageResult>({
    prompt: triagePrompt(ticket, project.name),
    cwd: project.path,
    schema: TRIAGE_SCHEMA,
    model: project.planner.model,
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: WRITE_TOOLS,
    maxTurns: 40,
    maxBudgetUsd: project.planner.maxBudgetUsd,
    timeoutMs: project.planner.timeoutMin * 60_000,
    appendSystemPrompt: PLANNER_SYSTEM,
  });
  return finish(res);
}

export async function resumeTriage(project: Project, sessionId: string, reply: string): Promise<PlannerOutcome> {
  const res = await callClaude<TriageResult>({
    prompt: triageResumePrompt(reply),
    cwd: project.path,
    schema: TRIAGE_SCHEMA,
    model: project.planner.model,
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: WRITE_TOOLS,
    maxTurns: 30,
    maxBudgetUsd: project.planner.maxBudgetUsd,
    timeoutMs: project.planner.timeoutMin * 60_000,
    resume: sessionId,
    appendSystemPrompt: PLANNER_SYSTEM,
  });
  return finish(res);
}

function finish(res: Awaited<ReturnType<typeof callClaude<TriageResult>>>): PlannerOutcome {
  if (!res.ok || !res.output) return { ok: false, error: res.error ?? 'planner returned nothing', sessionId: res.sessionId, costUsd: res.costUsd };
  const result = normalize(res.output);
  const bad = validate(result);
  if (bad) return { ok: false, error: `planner output invalid: ${bad}`, sessionId: res.sessionId, costUsd: res.costUsd };
  return { ok: true, result, sessionId: res.sessionId, costUsd: res.costUsd };
}
