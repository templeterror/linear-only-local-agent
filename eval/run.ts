// Eval harness: creates the tickets in Linear, drives the daemon in-process until every ticket settles,
// then writes eval/RESULTS.md with an honest expected-vs-actual table.
// Usage: linear-agent eval <project-path> [--only id,id] [--timeout-min 90] [--report-only]
// Do not run `linear-agent start` at the same time (two daemons on one SQLite DB would double-run tickets).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db, type Job } from '../src/db.ts';
import { Daemon } from '../src/daemon.ts';
import { Linear } from '../src/linear.ts';
import { getLinearApiKey } from '../src/config.ts';
import { loadProject } from '../src/registry.ts';
import { TERMINAL_STATES, IDLE_STATES } from '../src/state.ts';

interface Ticket {
  id: string;
  category: string;
  title: string;
  description: string;
  expect: 'automated' | 'automated+migration' | 'question' | 'declined';
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(DIR, '.state.json');

interface EvalState {
  projectPath: string;
  startedAt: string;
  issues: Record<string, { issueId: string; identifier: string; url: string }>;
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runEval(projectPath: string | undefined, args: string[]): Promise<void> {
  const reportOnly = args.includes('--report-only');
  const tickets: Ticket[] = JSON.parse(fs.readFileSync(path.join(DIR, 'tickets.json'), 'utf8'));
  const only = arg(args, '--only')?.split(',').map((s) => s.trim());
  const selected = only ? tickets.filter((t) => only.includes(t.id)) : tickets;
  const timeoutMin = Number(arg(args, '--timeout-min') ?? 90);

  let state: EvalState | null = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
  const db = new Db();

  if (!reportOnly) {
    if (!projectPath) throw new Error('usage: linear-agent eval <project-path>');
    const project = loadProject(projectPath);
    if (!project.enabled) throw new Error(`project ${project.name} is not enabled`);
    const key = getLinearApiKey();
    if (!key) throw new Error('LINEAR_API_KEY not configured');
    const linear = new Linear(key);

    if (!state || state.projectPath !== project.path) state = { projectPath: project.path, startedAt: new Date().toISOString(), issues: {} };
    for (const t of selected) {
      if (state.issues[t.id]) continue;
      const issue = await linear.createIssue(project.linear.teamKey, { title: `[eval ${t.id}] ${t.title}`, description: t.description, labelNames: [project.linear.label, 'eval'] });
      state.issues[t.id] = { issueId: issue.id, identifier: issue.identifier, url: issue.url };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`created ${issue.identifier} for ${t.id}`);
    }

    // Drive the daemon until every selected ticket settles or we time out.
    const daemon = new Daemon(db, () => [project]);
    const deadline = Date.now() + timeoutMin * 60_000;
    while (Date.now() < deadline) {
      await daemon.once();
      const jobs = selected.map((t) => db.getJob(state!.issues[t.id]?.issueId ?? ''));
      const pending = jobs.filter((j) => !j || !(TERMINAL_STATES.includes(j.state) || IDLE_STATES.includes(j.state)));
      console.log(`[eval] ${new Date().toISOString().slice(11, 19)} settled ${jobs.length - pending.length}/${jobs.length}` + (pending.length ? ` · pending: ${pending.map((j) => (j ? `${j.identifier}:${j.state}` : '?')).join(' ')}` : ''));
      if (!pending.length) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  if (!state) throw new Error('no eval state to report on');
  const rows = selected.map((t) => grade(t, db.getJob(state!.issues[t.id]?.issueId ?? ''), db));
  const md = render(rows, state);
  fs.writeFileSync(path.join(DIR, 'RESULTS.md'), md);
  console.log('\n' + md);
}

interface Row {
  t: Ticket;
  identifier: string;
  actual: string;
  pass: boolean;
  note: string;
}

function grade(t: Ticket, job: Job | null, db: Db): Row {
  if (!job) return { t, identifier: '-', actual: 'not picked up', pass: false, note: 'daemon never ingested the ticket' };
  const events = db.listEvents(job.issueId);
  const question = events.find((e) => e.toState === 'waiting_on_human')?.note?.replace(/^asked: /, '') ?? '';
  const declineReason = events.find((e) => e.toState === 'declined')?.note ?? '';
  let pass = false;
  let note = '';
  switch (t.expect) {
    case 'automated':
      pass = ['awaiting_approval', 'pr_open'].includes(job.state);
      note = pass ? `verified in ${job.attempt} attempt(s)` : job.state === 'failed' ? `failed: ${job.error}` : job.state === 'waiting_on_human' ? `asked instead: ${question}` : job.state;
      break;
    case 'automated+migration':
      pass = ['awaiting_approval', 'pr_open'].includes(job.state) && !!job.migrationSql;
      note = ['awaiting_approval', 'pr_open'].includes(job.state) ? (job.migrationSql ? 'migration SQL posted' : 'reached review WITHOUT migration SQL') : job.state === 'failed' ? `failed: ${job.error}` : job.state === 'waiting_on_human' ? `asked instead: ${question}` : job.state;
      break;
    case 'question':
      pass = job.state === 'waiting_on_human';
      note = pass ? `asked: ${question}` : job.state === 'declined' ? `declined: ${declineReason}` : `went ahead without asking (${job.state})`;
      break;
    case 'declined':
      pass = job.state === 'declined';
      note = pass ? `declined: ${declineReason}` : `NOT declined (${job.state})`;
      break;
  }
  return { t, identifier: job.identifier, actual: job.state, pass, note: note.slice(0, 220) };
}

function render(rows: Row[], state: EvalState): string {
  const passed = rows.filter((r) => r.pass).length;
  const lines = [
    `# Eval results`,
    '',
    `Project: \`${state.projectPath}\` · started ${state.startedAt} · **${passed}/${rows.length} passed**`,
    '',
    '| # | Category | Ticket | Expected | Actual state | Result | Notes |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.t.id} | ${r.t.category} | ${r.identifier} ${r.t.title} | ${r.t.expect} | \`${r.actual}\` | ${r.pass ? '✅' : '❌'} | ${r.note.replace(/\|/g, '\\|')} |`),
    '',
    '## Expected-outcome definitions',
    '- **automated**: planner marked it automatable, worker built it, verifier passed, preview posted → `awaiting_approval` (or `pr_open` if the approval gate is off).',
    '- **automated+migration**: as above AND migration SQL was extracted from the diff and posted on the ticket.',
    '- **question**: planner asked a clarifying question instead of guessing → `waiting_on_human`.',
    '- **declined**: planner refused (auth, payments, destructive SQL, out of scope) → `declined`, no worktree created.',
    '',
    '## Misses',
    ...(rows.filter((r) => !r.pass).map((r) => `- **${r.t.id}** (${r.identifier}): ${r.note}`) || []),
    ...(rows.every((r) => r.pass) ? ['- none'] : []),
    '',
  ];
  return lines.join('\n');
}
