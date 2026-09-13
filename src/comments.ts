// Markdown formatters for everything the daemon posts to Linear.
// Every comment starts with HEADER so humans (and the daemon) can tell them apart from replies.
import type { Spec } from './planner.ts';
import type { GuardViolation } from './guards.ts';

export const HEADER = '🤖 **linear-agent**';

export function isAgentComment(body: string): boolean {
  return body.trimStart().startsWith(HEADER);
}

const wrap = (title: string, body: string) => `${HEADER} · ${title}\n\n${body}`.trim();

export const fmt = {
  pickedUp: (projectName: string) => wrap('picked up', `Working on this in \`${projectName}\`. I'll triage it, write a spec, build it in an isolated worktree, run tests locally, verify, and post a preview here.`),

  question: (question: string) => wrap('question', `${question}\n\n_Reply in a comment and I'll continue from where I left off._`),

  declined: (reason: string) => wrap('declined', `I'm not going to automate this one.\n\n**Reason:** ${reason}\n\n_Remove and re-add the label to retry after editing the ticket._`),

  spec: (spec: Spec, branch: string, worker: string) =>
    wrap(
      'plan',
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
        p.approvalGate ? '**Reply `approve` to open a PR.** Any other reply is treated as change requests and sent back to the worker.' : 'Opening a PR now.',
      ].join('\n'),
    ),

  prOpened: (url: string) => wrap('PR opened', `${url}\n\nReview and merge when ready. Nothing is merged or deployed automatically.`),

  failed: (reason: string, detail?: string) => wrap('failed', `${reason}${detail ? `\n\n<details><summary>Details</summary>\n\n\`\`\`\n${detail.trim().slice(0, 4000)}\n\`\`\`\n</details>` : ''}\n\n_Remove and re-add the label to retry._`),

  guardFailure: (violations: GuardViolation[]) =>
    wrap('blocked by guardrail', ['The worker produced changes that violate a safety rule, so nothing was pushed:', '', ...violations.map((v) => `- **${v.rule}**${v.file ? ` in \`${v.file}\`` : ''}: ${v.detail}`), '', '_Remove and re-add the label to retry after editing the ticket._'].join('\n')),

  changesRequested: (text: string) => wrap('changes requested', `Got it — sending this back to the worker:\n\n> ${text.trim().replace(/\n/g, '\n> ')}`),
};
