// Markdown formatters for everything the daemon posts to Linear.
// Every comment starts with HEADER so humans (and the daemon) can tell them apart from replies.
import type { Spec } from './planner.ts';
import type { GuardViolation } from './guards.ts';

export const HEADER = '🤖 **linear-agent**';

export function isAgentComment(body: string): boolean {
  return body.trimStart().startsWith(HEADER);
}

const wrap = (title: string, body: string) => `${HEADER} · ${title}\n\n${body}`.trim();
const RETRY_HINT = '_Reply **`-tryagain-`** to redo the build in the same worktree, or **`-startover-`** for a fresh worktree and a new plan (edit the ticket first if it needs changes). Remove the label to drop it._';

export const fmt = {
  pickedUp: (projectName: string, planGate: boolean) =>
    wrap(
      'picked up',
      `Working on this in \`${projectName}\`. I'll triage it, write a plan, ${planGate ? 'wait for your approval on the plan, ' : ''}build it in an isolated worktree, run tests locally, verify, and post a preview here.${planGate ? '\n\n_Reply **`-autobuild-`** now to skip the plan review and build as soon as the plan is ready._' : ''}`,
    ),

  question: (question: string) => wrap('question', `${question}\n\n_Reply in a comment and I'll continue from where I left off. (\`-startover-\` re-plans from scratch.)_`),

  declined: (reason: string) => wrap('declined', `I'm not going to automate this one.\n\n**Reason:** ${reason}\n\n${RETRY_HINT}`),

  tryAgainAck: (state: 'building' | 'triaging' | 'awaiting_plan_approval', branch: string) =>
    wrap(
      'trying again',
      state === 'building'
        ? `Re-running the build on the existing branch \`${branch}\` (same worktree, same plan), then tests and verification.`
        : state === 'awaiting_plan_approval'
          ? `Keeping the existing plan and branch \`${branch}\`. The plan was never approved, so reply \`approve\` to start the build, or describe what to change.`
          : 'Re-planning from the ticket as it is now (same worktree).',
    ),

  resumedAck: (state: string) => wrap('resuming', `Picking up where I left off (\`${state}\`).`),

  startOverAck: () => wrap('starting over', 'Deleted the worktree and local branch. Starting from scratch: fresh triage, fresh plan, fresh build.'),

  noChanges: (summary: string) =>
    wrap('no changes made', `The worker didn't change anything in response to that request. Its explanation:\n\n> ${summary.trim().slice(0, 1500).replace(/\n/g, '\n> ')}\n\nThe previous build is still on the branch. Reply with different instructions, or \`approve\` to open the PR as is.`),

  spec: (spec: Spec, branch: string, worker: string, opts: { gate: boolean; revised: boolean }) =>
    wrap(
      opts.revised ? 'revised plan' : 'plan',
      [
        `**Branch:** \`${branch}\` · **worker:** ${worker} · **planner/verifier:** Claude Code`,
        '',
        `**Summary:** ${spec.summary}`,
        '',
        '**Steps:**',
        ...spec.steps.map((s, i) => `${i + 1}. ${s}`),
        '',
        '**Acceptance criteria:**',
        ...spec.acceptanceCriteria.map((c) => `- [ ] ${c}`),
        spec.filesLikelyTouched?.length ? `\n**Files likely touched:** ${spec.filesLikelyTouched.map((f) => `\`${f}\``).join(', ')}` : '',
        spec.needsMigration ? '\n⚠️ This change needs a database migration. SQL will be posted here before any PR is opened.' : '',
        '',
        opts.gate ? '**Reply `approve` to start the build.** Anything else is taken as feedback on the plan and I will post a revised one. `-startover-` re-plans from scratch.' : 'Starting the build now.',
      ].join('\n'),
    ),

  planApproved: () => wrap('plan approved', 'Starting the build.'),

  planPreApproved: () => wrap('autobuild', "Got it — I'll start building as soon as the plan is ready, without waiting for a review."),

  planChangesRequested: (text: string) => wrap('revising the plan', `Taking this back to the planner:\n\n> ${text.trim().replace(/\n/g, '\n> ')}`),

  built: (p: { attempt: number; diffStat: string; summary: string }) =>
    wrap(
      `built (attempt ${p.attempt})`,
      [
        '**Changes:**',
        '```',
        p.diffStat.trim() || '(no diff)',
        '```',
        p.summary.trim() ? `\n<details><summary>Worker summary</summary>\n\n${p.summary.trim().slice(0, 3000)}\n</details>` : '',
        '',
        '_Running tests and the verifier next._',
      ].join('\n'),
    ),

  retrying: (attempt: number, max: number, fix: string) => wrap(`verifier requested changes (retry ${attempt}/${max})`, `${fix}\n\n_Sending these instructions back to the worker._`),

  preview: (p: { attempt: number; diffStat: string; testPassed: boolean | null; testTail: string; screenshotUrl: string | null; migrationSql: string; criteria: { criterion: string; met: boolean; evidence: string }[]; approvalGate: boolean; branch: string }) =>
    wrap(
      'ready for review',
      [
        p.screenshotUrl ? `![preview](${p.screenshotUrl})\n` : '',
        `**Branch:** \`${p.branch}\` · **attempts:** ${p.attempt}`,
        '',
        `**Tests:** ${p.testPassed === null ? 'not run' : p.testPassed ? '✅ passing' : '❌ failing (verifier accepted with explanation below)'}`,
        '',
        '**Acceptance criteria:**',
        ...p.criteria.map((c) => `- ${c.met ? '✅' : '⚠️'} ${c.criterion}${c.evidence ? ` — _${c.evidence}_` : ''}`),
        '',
        '**Changes:**',
        '```',
        p.diffStat.trim(),
        '```',
        p.migrationSql ? `\n**Migration SQL (review before merging; run on prod manually):**\n\`\`\`sql\n${p.migrationSql.trim()}\n\`\`\`` : '',
        p.testTail ? `\n<details><summary>Test output (tail)</summary>\n\n\`\`\`\n${p.testTail.trim()}\n\`\`\`\n</details>` : '',
        '',
        p.approvalGate ? '**Reply `approve` to open a PR.** Describe changes and they go back to the worker. `-tryagain-` redoes the build in this worktree; `-startover-` begins from scratch.' : 'Opening a PR now.',
      ].join('\n'),
    ),

  prOpened: (url: string) => wrap('PR opened', `${url}\n\nReview and merge when ready. Nothing is merged or deployed automatically.`),

  failed: (reason: string, detail?: string) => wrap('failed', `${reason}${detail ? `\n\n<details><summary>Details</summary>\n\n\`\`\`\n${detail.trim().slice(0, 4000)}\n\`\`\`\n</details>` : ''}\n\n${RETRY_HINT}`),

  guardFailure: (violations: GuardViolation[]) =>
    wrap('blocked by guardrail', ['The worker produced changes that violate a safety rule, so nothing was pushed:', '', ...violations.map((v) => `- **${v.rule}**${v.file ? ` in \`${v.file}\`` : ''}: ${v.detail}`), '', RETRY_HINT].join('\n')),

  paused: (reason: string, resumeAt: Date) =>
    wrap('paused', `Usage limit hit: _${reason}_\n\nNothing was lost — I'll pick this up again automatically at **${resumeAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}** (${Intl.DateTimeFormat().resolvedOptions().timeZone}). No action needed.\n\n_To resume sooner (limit reset early, or you switched the worker), reply \`-tryagain-\`._`),

  changesRequested: (text: string) => wrap('changes requested', `Got it — sending this back to the worker:\n\n> ${text.trim().replace(/\n/g, '\n> ')}`),
};
