// One handler per job state. Each handler does its work, persists, and transitions. Handlers are idempotent
// enough to be re-run after a daemon restart (worktree reuse, cheap planner re-call, worker resumes partial tree).
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.ts';
import type { Db, Job } from './db.ts';
import type { Linear, LinearComment } from './linear.ts';
import type { Project } from './registry.ts';
import { fmt } from './comments.ts';
import { triage, resumeTriage, revisePlan, type PlannerOutcome, type Spec } from './planner.ts';
import { verify } from './verifier.ts';
import { getExecutor } from './executors/index.ts';
import type { UsageLimit } from './claude-cli.ts';
import { ACTIVE_STATES } from './state.ts';
import { workerPrompt, workerFixPrompt } from './prompts/index.ts';
import { ensureWorktree, removeWorktree, deleteLocalBranch, stageAndDiff, commitAll, commitsAhead, pushBranch, slugify } from './git.ts';
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

/**
 * A subscription usage limit is not a failure: keep the job in its current state, set retryAfter so the daemon
 * skips it until the limit resets, and tell the human once per hour at most.
 */
async function pause(ctx: Ctx, job: Job, limit: UsageLimit): Promise<void> {
  const resumeAt = limit.retryAt ?? new Date(Date.now() + 15 * 60_000);
  log(job.identifier, `paused in ${job.state} until ${resumeAt.toISOString()}: ${limit.message}`);
  ctx.db.updateJob(job.issueId, { retryAfter: resumeAt.toISOString() });
  ctx.db.addEvent(job.issueId, `paused (usage limit) until ${resumeAt.toISOString()}: ${limit.message}`);
  const lastNotice = ctx.db.listEvents(job.issueId).filter((e) => e.note?.startsWith('paused-notice')).pop();
  if (!lastNotice || Date.now() - new Date(lastNotice.at).getTime() > 60 * 60_000) {
    await post(ctx, job, fmt.paused(limit.message, resumeAt));
    ctx.db.addEvent(job.issueId, 'paused-notice posted');
  }
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
  await post(ctx, job, fmt.pickedUp(ctx.project.name, ctx.project.planApprovalGate && !job.planApproved));
  ctx.db.transition(job.issueId, 'triaging');
}

async function applyTriage(ctx: Ctx, job: Job, out: PlannerOutcome): Promise<void> {
  if (out.limit) return pause(ctx, job, out.limit);
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
    // planPosted 0 (not null) marks a spec that replaces an earlier posted one, so the next plan comment says "revised".
    ctx.db.transition(job.issueId, 'planning', r.reason.slice(0, 200), { ...patch, specJson: JSON.stringify(r.spec), planPosted: job.planPosted ? 0 : job.planPosted });
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
  const wt = await ensureWorktree({ repo: project.path, worktree, branch, base: project.git.baseBranch, remote: project.git.remote });
  log(job.identifier, `worktree ${wt.created ? 'created' : 'reused'} at ${worktree} on ${branch}`);
  const deps = await linkOrInstallDeps(project, worktree);
  if (!deps.ok) return fail(ctx, job, 'dependency install failed in worktree', deps.output);
  ctx.db.updateJob(job.issueId, { worktree, branch });
  // Re-read: a `-approveplan-` comment may have landed while the worktree was being prepared.
  job = ctx.db.getJob(job.issueId)!;
  const gate = project.planApprovalGate && !job.planApproved;
  if (!job.planPosted) {
    const w = workerFor(project, job);
    await post(ctx, job, fmt.spec(specOf(job), branch, `${w.kind} (${w.model})`, { gate, revised: job.planPosted === 0 }));
    ctx.db.updateJob(job.issueId, { planPosted: 1 });
  }
  if (gate) ctx.db.transition(job.issueId, 'awaiting_plan_approval', `deps: ${deps.method}; waiting for plan approval`);
  else ctx.db.transition(job.issueId, 'building', `deps: ${deps.method}${job.planApproved ? '; plan pre-approved' : ''}`);
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
  if (res.limit) return pause(ctx, job, res.limit);
  if (!res.ok && res.files.length === 0) return fail(ctx, job, `worker failed: ${res.error}`, res.summary);

  const violations = scanDiff(res.diff, res.files);
  if (violations.length) {
    log(job.identifier, `guardrail violations: ${violations.map((v) => v.rule).join(',')}`);
    await post(ctx, job, fmt.guardFailure(violations));
    ctx.db.transition(job.issueId, 'failed', 'guardrail: ' + violations.map((v) => v.rule).join(','), { error: 'guardrail violation' });
    return;
  }
  // A human asked for changes and the worker made none (usually because the request collided with its rules):
  // hand the worker's explanation back instead of re-verifying an unchanged branch.
  if (isFix && res.files.length === 0 && job.attempt === 0 && (await commitsAhead(job.worktree, `${project.git.remote}/${project.git.baseBranch}`)) > 0) {
    await post(ctx, job, fmt.noChanges(res.summary));
    ctx.db.transition(job.issueId, 'awaiting_approval', 'change request produced no changes', { fixInstructions: null });
    return;
  }
  await post(ctx, job, fmt.built({ attempt: job.attempt + 1, diffStat: res.diffStat, summary: res.summary }));
  ctx.db.transition(job.issueId, 'testing', `${res.files.length} files changed`, { migrationSql: extractMigrationSql(res.diff) || job.migrationSql, fixInstructions: null });
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
  const baseRef = `${project.git.remote}/${project.git.baseBranch}`;
  const staged = await stageAndDiff(job.worktree, baseRef); // whole branch: committed earlier attempts + new work
  const testExit = job.testPassed === null ? null : job.testPassed ? 0 : 1;
  const out = await verify({ project, worktree: job.worktree, ticket: ticketOf(job), spec, testExit, testOutput: job.testOutput ?? '', diff: staged.diff, diffStat: staged.diffStat });
  if (out.limit) return pause(ctx, job, out.limit);
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
  if (!sha && (await commitsAhead(job.worktree, baseRef)) === 0) return fail(ctx, job, 'verifier passed but the branch has no changes (empty diff)');
  await pushBranch({ worktree: job.worktree, remote: project.git.remote, branch: job.branch, base: project.git.baseBranch, branchPrefix: project.git.branchPrefix });
  log(job.identifier, `pushed ${job.branch}${sha ? ` @ ${sha.slice(0, 8)}` : ' (no new commit)'}`);

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
/** `-tryagain-`: same worktree, redo from the build step. Dashes make it unmistakable from ordinary conversation.
 *  Linear's editor markdown-escapes a leading dash (`\-tryagain-`), so both dashes may carry a backslash. */
const RETRY_RE = /^\s*\\?-tryagain\\?-\s*$/i;
/** `-startover-`: fresh worktree, fresh triage. */
const START_OVER_RE = /^\s*\\?-startover\\?-\s*$/i;
/** `-approveplan-`: approve the plan at the gate, or pre-approve it any time earlier so the build starts unattended. */
const APPROVE_PLAN_RE = /^\s*\\?-approveplan\\?-\s*$/i;

/** True for comments the daemon acts on even while a job is mid-step (checked between steps). */
export function isCommand(text: string): boolean {
  const t = text.trim();
  return START_OVER_RE.test(t) || RETRY_RE.test(t) || APPROVE_PLAN_RE.test(t);
}

/** Plan approval: at the gate it starts the build; before the gate it records a pre-approval; later it is a no-op. */
async function approvePlan(ctx: Ctx, job: Job): Promise<void> {
  if (job.state === 'awaiting_plan_approval') {
    await post(ctx, job, fmt.planApproved());
    ctx.db.transition(job.issueId, 'building', 'plan approved by human', { planApproved: 1, attempt: 0, fixInstructions: null });
    log(job.identifier, 'plan approved');
  } else if (['queued', 'triaging', 'planning', 'waiting_on_human'].includes(job.state)) {
    if (!job.planApproved) {
      ctx.db.updateJob(job.issueId, { planApproved: 1 });
      ctx.db.addEvent(job.issueId, 'plan pre-approved by human');
      await post(ctx, job, fmt.planPreApproved());
    }
    log(job.identifier, 'plan pre-approved');
  } else {
    log(job.identifier, `-approveplan- ignored in ${job.state}`);
  }
}

/** `try again`: keep the worktree/branch, go back to building (or triaging if there is no spec yet). */
async function tryAgain(ctx: Ctx, job: Job): Promise<void> {
  const fresh = await ctx.linear.issue(job.issueId);
  const patch = { attempt: 0, error: null, fixInstructions: null, retryAfter: null, archived: 0, title: fresh?.title ?? job.title, description: fresh?.description ?? job.description };
  if (job.retryAfter && ACTIVE_STATES.includes(job.state)) {
    // Paused on a usage limit: just release it in place.
    ctx.db.forceState(job.issueId, job.state, 'resumed early by human', patch);
    await post(ctx, job, fmt.resumedAck(job.state));
  } else if (job.specJson && job.worktree && ctx.project.planApprovalGate && !job.planApproved) {
    // The plan was never approved (failed before the gate, or declined): go back to the gate, not straight to the build.
    ctx.db.forceState(job.issueId, 'awaiting_plan_approval', 'try again (plan not yet approved)', patch);
    await post(ctx, job, fmt.tryAgainAck('awaiting_plan_approval', job.branch ?? ''));
  } else if (job.specJson && job.worktree) {
    ctx.db.forceState(job.issueId, 'building', 'try again (same worktree)', patch);
    await post(ctx, job, fmt.tryAgainAck('building', job.branch ?? ''));
  } else {
    ctx.db.forceState(job.issueId, 'triaging', 'try again (re-triage)', { ...patch, plannerSessionId: null });
    await post(ctx, job, fmt.tryAgainAck('triaging', ''));
  }
  log(job.identifier, 'try again requested via comment');
}

/** `start over`: throw away the worktree and branch, start from queued as if the label had just been added. */
async function startOver(ctx: Ctx, job: Job): Promise<void> {
  const { project } = ctx;
  if (job.worktree) await removeWorktree(project.path, job.worktree).catch((e) => log(job.identifier, `worktree remove failed: ${e.message}`));
  if (job.branch) await deleteLocalBranch(project.path, job.branch).catch(() => null);
  const fresh = await ctx.linear.issue(job.issueId);
  ctx.db.resetJob(job.issueId, 'start over (fresh worktree)');
  ctx.db.updateJob(job.issueId, { worktree: null, branch: null, diffSummary: null, testOutput: null, testPassed: null, screenshotUrl: null, migrationSql: null, title: fresh?.title ?? job.title, description: fresh?.description ?? job.description });
  await post(ctx, job, fmt.startOverAck());
  log(job.identifier, 'start over requested via comment');
}

/** Called by the daemon when a human comments on a job in an idle or finished state. */
export async function handleHumanComment(ctx: Ctx, issueId: string, comment: LinearComment): Promise<void> {
  const job = ctx.db.getJob(issueId);
  if (!job) return;
  const text = comment.body.trim();
  log(job.identifier, `human comment in ${job.state}: ${text.slice(0, 80)}`);
  try {
    // Explicit commands work in every state the daemon listens in.
    if (START_OVER_RE.test(text)) return await startOver(ctx, job);
    if (RETRY_RE.test(text)) return await tryAgain(ctx, job);
    if (APPROVE_PLAN_RE.test(text)) return await approvePlan(ctx, job);
    // Mid-step (not paused): only the explicit commands above act; anything else waits for the next idle state.
    if (ACTIVE_STATES.includes(job.state) && !job.retryAfter) return;

    if (job.state === 'waiting_on_human') {
      const out = job.plannerSessionId
        ? await resumeTriage(ctx.project, job.plannerSessionId, text)
        : await triage(ctx.project, { ...ticketOf(job), description: `${job.description ?? ''}\n\nDeveloper clarification:\n${text}` });
      await applyTriage(ctx, job, out);
    } else if (job.state === 'awaiting_plan_approval') {
      if (APPROVE_RE.test(text)) return await approvePlan(ctx, job);
      await post(ctx, job, fmt.planChangesRequested(text));
      const out = await revisePlan(ctx.project, job.plannerSessionId, ticketOf(job), text, specOf(job));
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
    // failed / declined: only the two commands above do anything; other comments are conversation.
  } catch (e: any) {
    const fresh = ctx.db.getJob(issueId);
    if (fresh && !['failed', 'declined', 'pr_open'].includes(fresh.state)) await fail(ctx, fresh, `error handling comment: ${e.message}`, e.stack);
  }
}
