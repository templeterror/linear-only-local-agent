// One handler per job state. Each handler does its work, persists, and transitions. Handlers are idempotent
// enough to be re-run after a daemon restart (worktree reuse, cheap planner re-call, worker resumes partial tree).
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.ts';
import type { Db, Job } from './db.ts';
import type { Linear, LinearComment } from './linear.ts';
import type { Project } from './registry.ts';
import { fmt } from './comments.ts';
import { triage, resumeTriage, type PlannerOutcome, type Spec } from './planner.ts';
import { verify } from './verifier.ts';
import { getExecutor } from './executors/index.ts';
import { workerPrompt, workerFixPrompt } from './prompts/index.ts';
import { ensureWorktree, stageAndDiff, commitAll, pushBranch, slugify } from './git.ts';
import { createPr } from './github.ts';
import { linkOrInstallDeps, runTests, bootAndScreenshot } from './runner.ts';
import { scanDiff, extractMigrationSql } from './guards.ts';
import { log } from './log.ts';

export interface Ctx {
  db: Db;
  linear: Linear;
  project: Project;
}

const ticketOf = (job: Job) => ({ identifier: job.identifier, title: job.title, description: job.description, url: job.url });
const specOf = (job: Job): Spec => JSON.parse(job.specJson ?? '{}');

async function post(ctx: Ctx, job: Job, body: string): Promise<void> {
  const c = await ctx.linear.createComment(job.issueId, body);
  ctx.db.recordAgentComment(job.issueId, c.id);
  ctx.db.markSeen(job.issueId, c.id);
}

async function fail(ctx: Ctx, job: Job, reason: string, detail?: string): Promise<void> {
  log(job.identifier, `FAILED: ${reason}`);
  try {
    await post(ctx, job, fmt.failed(reason, detail));
  } catch (e: any) {
    log(job.identifier, `could not post failure comment: ${e.message}`);
  }
  ctx.db.transition(job.issueId, 'failed', reason, { error: reason });
}

/** Entry point used by the daemon. Re-reads the job so the dispatch is always on fresh state. */
export async function runStep(ctx: Ctx, issueId: string): Promise<void> {
  const job = ctx.db.getJob(issueId);
  if (!job) return;
  log(job.identifier, `step ${job.state}`);
  try {
    switch (job.state) {
      case 'queued':
        return await stepQueued(ctx, job);
      case 'triaging':
        return await stepTriaging(ctx, job);
      case 'planning':
        return await stepPlanning(ctx, job);
      case 'building':
        return await stepBuilding(ctx, job);
      case 'testing':
        return await stepTesting(ctx, job);
      case 'verifying':
        return await stepVerifying(ctx, job);
      default:
        return;
    }
  } catch (e: any) {
    const fresh = ctx.db.getJob(issueId);
    if (fresh && !['failed', 'declined', 'pr_open'].includes(fresh.state)) await fail(ctx, fresh, `unexpected error in ${fresh.state}: ${e.message}`, e.stack);
  }
}

async function stepQueued(ctx: Ctx, job: Job): Promise<void> {
  await post(ctx, job, fmt.pickedUp(ctx.project.name));
  ctx.db.transition(job.issueId, 'triaging');
}

async function applyTriage(ctx: Ctx, job: Job, out: PlannerOutcome): Promise<void> {
  if (!out.ok || !out.result) return fail(ctx, job, `planner failed: ${out.error}`);
  const r = out.result;
  const patch = { plannerSessionId: out.sessionId ?? job.plannerSessionId };
  if (r.decision === 'out_of_scope') {
    await post(ctx, job, fmt.declined(r.reason));
    ctx.db.transition(job.issueId, 'declined', r.reason, patch);
  } else if (r.decision === 'needs_clarification') {
    await post(ctx, job, fmt.question(r.question));
    ctx.db.transition(job.issueId, 'waiting_on_human', 'asked: ' + r.question.slice(0, 120), patch);
  } else {
    ctx.db.transition(job.issueId, 'planning', r.reason.slice(0, 200), { ...patch, specJson: JSON.stringify(r.spec) });
  }
}

async function stepTriaging(ctx: Ctx, job: Job): Promise<void> {
  const out = await triage(ctx.project, ticketOf(job));
  await applyTriage(ctx, job, out);
}

const DEFAULT_MODEL: Record<'cursor' | 'claude', string> = { cursor: 'sonnet-4.5', claude: 'sonnet' };

/** Project default worker unless the ticket carried a `worker:<kind>` label. */
export function workerFor(project: Project, job: Job): { kind: 'cursor' | 'claude'; model: string } {
  const kind = job.workerKind ?? project.worker.kind;
  return { kind, model: kind === project.worker.kind ? project.worker.model : DEFAULT_MODEL[kind] };
}

export function branchFor(project: Project, job: Job): string {
  return `${project.git.branchPrefix}${job.identifier.toLowerCase()}-${slugify(job.title)}`;
}

async function stepPlanning(ctx: Ctx, job: Job): Promise<void> {
  const { project } = ctx;
  const branch = job.branch ?? branchFor(project, job);
  const worktree = job.worktree ?? path.join(PATHS.worktrees, project.name, job.identifier);
  const firstTime = !job.worktree;
  const wt = await ensureWorktree({ repo: project.path, worktree, branch, base: project.git.baseBranch, remote: project.git.remote });
  log(job.identifier, `worktree ${wt.created ? 'created' : 'reused'} at ${worktree} on ${branch}`);
  const deps = await linkOrInstallDeps(project, worktree);
  if (!deps.ok) return fail(ctx, job, 'dependency install failed in worktree', deps.output);
  ctx.db.updateJob(job.issueId, { worktree, branch });
  if (firstTime) {
    const w = workerFor(project, job);
    await post(ctx, job, fmt.spec(specOf(job), branch, `${w.kind} (${w.model})`));
  }
  ctx.db.transition(job.issueId, 'building', `deps: ${deps.method}`);
}

async function stepBuilding(ctx: Ctx, job: Job): Promise<void> {
  const { project } = ctx;
  if (!job.worktree || !job.branch) return fail(ctx, job, 'no worktree recorded for building step');
  const spec = specOf(job);
  const { kind, model } = workerFor(project, job);
  const executor = getExecutor(kind);
  const isFix = !!job.fixInstructions;
  const prompt = isFix
    ? workerFixPrompt({ ticket: ticketOf(job), spec, fixInstructions: job.fixInstructions!, testCommand: project.commands.test })
    : workerPrompt({ ticket: ticketOf(job), spec, branch: job.branch, testCommand: project.commands.test, applyMigrationsToDev: project.supabase.applyToDev });
  log(job.identifier, `worker=${executor.kind} model=${model} fix=${isFix}`);
  const res = await executor.run({ worktree: job.worktree, prompt, model, timeoutMs: project.worker.timeoutMin * 60_000, resumeId: isFix ? job.workerSessionId ?? undefined : undefined });
  ctx.db.updateJob(job.issueId, { workerSessionId: res.sessionId ?? job.workerSessionId, diffSummary: res.diffStat });
  if (!res.ok && res.files.length === 0) return fail(ctx, job, `worker failed: ${res.error}`, res.summary);

  const violations = scanDiff(res.diff, res.files);
  if (violations.length) {
    log(job.identifier, `guardrail violations: ${violations.map((v) => v.rule).join(',')}`);
    await post(ctx, job, fmt.guardFailure(violations));
    ctx.db.transition(job.issueId, 'failed', 'guardrail: ' + violations.map((v) => v.rule).join(','), { error: 'guardrail violation' });
    return;
  }
  ctx.db.transition(job.issueId, 'testing', `${res.files.length} files changed`, { migrationSql: extractMigrationSql(res.diff) || null, fixInstructions: null });
}

async function stepTesting(ctx: Ctx, job: Job): Promise<void> {
  const { project } = ctx;
  if (!job.worktree) return fail(ctx, job, 'no worktree recorded for testing step');
  const tests = await runTests(project, job.worktree);
  log(job.identifier, `tests ran=${tests.ran} passed=${tests.passed} code=${tests.code} in ${(tests.durationMs / 1000).toFixed(0)}s`);

  let screenshotUrl: string | null = null;
  if (project.screenshots && project.commands.dev) {
    const spec = specOf(job);
    const out = path.join(PATHS.artifacts, project.name, `${job.identifier}-${job.attempt + 1}.png`);
    const preview = await bootAndScreenshot(project, job.worktree, spec.previewRoute || '', out);
    if (preview.ok && preview.screenshotPath) {
      try {
        screenshotUrl = await ctx.linear.uploadFile(path.basename(out), 'image/png', fs.readFileSync(preview.screenshotPath));
        log(job.identifier, `screenshot uploaded: ${screenshotUrl}`);
      } catch (e: any) {
        log(job.identifier, `screenshot upload failed: ${e.message}`);
      }
    } else {
      log(job.identifier, `preview skipped: ${preview.error}`);
      ctx.db.addEvent(job.issueId, `preview skipped: ${preview.error}`);
    }
  }
  ctx.db.transition(job.issueId, 'verifying', tests.ran ? (tests.passed ? 'tests passed' : 'tests failed') : 'tests not run', {
    testOutput: tests.output,
    testPassed: tests.ran ? (tests.passed ? 1 : 0) : null,
    screenshotUrl,
  });
}

async function stepVerifying(ctx: Ctx, job: Job): Promise<void> {
  const { project } = ctx;
  if (!job.worktree || !job.branch) return fail(ctx, job, 'no worktree recorded for verifying step');
  const spec = specOf(job);
  const staged = await stageAndDiff(job.worktree);
  const testExit = job.testPassed === null ? null : job.testPassed ? 0 : 1;
  const out = await verify({ project, worktree: job.worktree, ticket: ticketOf(job), spec, testExit, testOutput: job.testOutput ?? '', diff: staged.diff, diffStat: staged.diffStat });
  if (!out.ok || !out.verdict) return fail(ctx, job, `verifier failed: ${out.error}`);
  const v = out.verdict;
  const attempt = job.attempt + 1;
  log(job.identifier, `verdict=${v.verdict} attempt=${attempt} met=${v.criteria.filter((c) => c.met).length}/${v.criteria.length}`);

  if (v.verdict === 'fail') {
    if (attempt <= project.verifier.maxRetries) {
      await post(ctx, job, fmt.retrying(attempt, project.verifier.maxRetries, v.fixInstructions));
      ctx.db.transition(job.issueId, 'building', `verifier fail, retry ${attempt}`, { attempt, fixInstructions: v.fixInstructions });
    } else {
      await post(ctx, job, fmt.failed(`Verifier rejected the change after ${attempt} attempts. ${v.summary}`, v.fixInstructions));
      ctx.db.transition(job.issueId, 'failed', 'verifier exhausted retries', { attempt, error: 'verifier rejected' });
    }
    return;
  }

  // pass → commit, push, post preview
  const sha = await commitAll(job.worktree, `${job.identifier}: ${job.title}\n\n${spec.summary}\n\nLinear: ${job.url ?? job.identifier}`);
  if (!sha) return fail(ctx, job, 'verifier passed but there is nothing to commit (empty diff)');
  await pushBranch({ worktree: job.worktree, remote: project.git.remote, branch: job.branch, base: project.git.baseBranch, branchPrefix: project.git.branchPrefix });
  log(job.identifier, `pushed ${job.branch} @ ${sha.slice(0, 8)}`);

  await post(
    ctx,
    job,
    fmt.preview({ attempt, diffStat: staged.diffStat, testPassed: job.testPassed === null ? null : job.testPassed === 1, testTail: (job.testOutput ?? '').split('\n').slice(-40).join('\n'), screenshotUrl: job.screenshotUrl, migrationSql: job.migrationSql ?? '', criteria: v.criteria, approvalGate: project.approvalGate, branch: job.branch }),
  );
  ctx.db.updateJob(job.issueId, { attempt });
  if (project.approvalGate) {
    ctx.db.transition(job.issueId, 'awaiting_approval', v.summary.slice(0, 200));
  } else {
    const url = await openPr(ctx, ctx.db.getJob(job.issueId)!);
    ctx.db.transition(job.issueId, 'pr_open', url, { prUrl: url });
  }
}

async function openPr(ctx: Ctx, job: Job): Promise<string> {
  const { project } = ctx;
  const spec = specOf(job);
  const body = [
    `Closes Linear ticket [${job.identifier}](${job.url ?? ''}).`,
    '',
    '## Summary',
    spec.summary,
    '',
    '## Acceptance criteria',
    ...spec.acceptanceCriteria.map((c) => `- ${c}`),
    job.migrationSql ? `\n## Migration SQL (run on prod manually after merge)\n\`\`\`sql\n${job.migrationSql.trim()}\n\`\`\`` : '',
    job.screenshotUrl ? `\n## Preview\n![preview](${job.screenshotUrl})` : '',
    '',
    `_Planned and verified by Claude Code, built by ${project.worker.kind}, on the developer's machine via linear-agent._`,
  ].join('\n');
  const url = await createPr({ worktree: job.worktree!, base: project.git.baseBranch, head: job.branch!, title: `${job.identifier}: ${job.title}`, body });
  log(job.identifier, `PR ${url}`);
  try {
    await ctx.linear.attachLink(job.issueId, url, `PR: ${job.identifier}`);
  } catch (e: any) {
    log(job.identifier, `attachLink failed: ${e.message}`);
  }
  try {
    const states = await ctx.linear.states(project.linear.teamKey);
    const st = states.find((s) => s.name.toLowerCase() === project.linear.reviewState.toLowerCase());
    if (st) await ctx.linear.updateIssueState(job.issueId, st.id);
  } catch (e: any) {
    log(job.identifier, `state update failed: ${e.message}`);
  }
  await post(ctx, job, fmt.prOpened(url));
  return url;
}

const APPROVE_RE = /^\s*(approve[d]?|lgtm|ship( it)?|:shipit:|✅|👍|yes,? (open|create) (the |a )?pr)\b/i;

/** Called by the daemon when a human comments on a job in an idle state. */
export async function handleHumanComment(ctx: Ctx, issueId: string, comment: LinearComment): Promise<void> {
  const job = ctx.db.getJob(issueId);
  if (!job) return;
  const text = comment.body.trim();
  log(job.identifier, `human comment in ${job.state}: ${text.slice(0, 80)}`);
  try {
    if (job.state === 'waiting_on_human') {
      const out = job.plannerSessionId
        ? await resumeTriage(ctx.project, job.plannerSessionId, text)
        : await triage(ctx.project, { ...ticketOf(job), description: `${job.description ?? ''}\n\nDeveloper clarification:\n${text}` });
      await applyTriage(ctx, job, out);
    } else if (job.state === 'awaiting_approval') {
      if (APPROVE_RE.test(text)) {
        const url = await openPr(ctx, job);
        ctx.db.transition(job.issueId, 'pr_open', 'approved by human', { prUrl: url });
      } else {
        await post(ctx, job, fmt.changesRequested(text));
        ctx.db.transition(job.issueId, 'building', 'changes requested by human', { fixInstructions: text, attempt: 0 });
      }
    }
  } catch (e: any) {
    const fresh = ctx.db.getJob(issueId);
    if (fresh && !['failed', 'declined', 'pr_open'].includes(fresh.state)) await fail(ctx, fresh, `error handling comment: ${e.message}`, e.stack);
  }
}
