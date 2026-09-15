// End-to-end integration test with a fake Linear and a local bare git "origin".
//   npx tsx test/integration.ts            # full run incl. crash-and-restart mid-build (~3-5 min, ~$1 of Claude budget)
//
// What it proves: ingest → triage → plan → plan gate (feedback → revised plan → approve) → worker → tests → screenshot
// → verify → push → preview comment, that a SIGKILL during `building` leaves the job resumable and no comment is posted
// twice, and that an `approve` reply is routed to the PR step (which fails here only because the bare repo is not on GitHub).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.LINEAR_AGENT_HOME ?? '/tmp/la-integration';
const SAMPLE = process.env.SAMPLE_APP ?? path.resolve(ROOT, '..', 'sample-app');
const REPO = path.join(HOME, 'sample-app');
const ORIGIN = path.join(HOME, 'origin.git');
const FAKE = path.join(HOME, 'fake-linear.json');
const WORKER = process.env.WORKER_KIND ?? 'claude';

const isChild = process.argv.includes('--child');
if (isChild) await childMain();
else await parentMain();

// ---------------------------------------------------------------- child: run the real daemon against the fake
async function childMain() {
  process.env.LINEAR_AGENT_HOME = HOME;
  const { Db } = await import('../src/db.ts');
  const { Daemon } = await import('../src/daemon.ts');
  const { mergeConfig } = await import('../src/config.ts');
  const { FakeLinear } = await import('./fake-linear.ts');
  const { TERMINAL_STATES, IDLE_STATES } = await import('../src/state.ts');
  const fake = new FakeLinear(FAKE);
  const project = {
    ...mergeConfig({ linear: { teamKey: 'ENG', label: 'agent', reviewState: 'In Review', assigneeOnly: false }, worker: { kind: WORKER as any, model: WORKER === 'claude' ? 'sonnet' : 'sonnet-4.5', timeoutMin: 15 }, commands: { install: 'npm ci', test: 'npm test', dev: 'npm run dev', devUrl: 'http://localhost:{port}', devReadyPath: '/' }, pollSeconds: 5 }),
    path: REPO,
    name: 'sample-app',
    enabled: true,
    hasConfigFile: true,
  };
  const db = new Db();
  const daemon = new Daemon(db, () => [project], fake.asLinear());
  for (;;) {
    await daemon.once();
    const jobs = db.listJobs();
    const settled = jobs.length > 0 && jobs.every((j) => TERMINAL_STATES.includes(j.state) || IDLE_STATES.includes(j.state));
    if (settled) process.exit(0);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---------------------------------------------------------------- parent: orchestrate, crash, assert
async function parentMain() {
  const { execSync } = await import('node:child_process');
  console.log(`home=${HOME} sample=${SAMPLE} worker=${WORKER}`);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  execSync(`git clone -q --bare "${SAMPLE}" "${ORIGIN}" && git clone -q "${ORIGIN}" "${REPO}"`, { stdio: 'inherit' });
  fs.symlinkSync(path.join(SAMPLE, 'node_modules'), path.join(REPO, 'node_modules'), 'dir');

  process.env.LINEAR_AGENT_HOME = HOME;
  const { FakeLinear } = await import('./fake-linear.ts');
  const { Db } = await import('../src/db.ts');
  const fake = new FakeLinear(FAKE);
  const issue = fake.addIssue({
    identifier: 'ENG-42',
    title: 'Show the note count in the home page header',
    description: 'On the home page (app/page.tsx) the header currently just says "Notes". Change it to "Notes (N)" where N is the number of notes rendered. Add a test in app/page.test.tsx that renders the page with the sample notes and asserts the count is shown.',
  });
  const db = () => new Db(path.join(HOME, 'state.db'));
  const state = () => db().getJob(issue.id)?.state ?? '(none)';
  const commentsByKind = () => {
    const bodies = new FakeLinear(FAKE).dump().comments[issue.id].map((c) => c.body.split('\n')[0]);
    return bodies.reduce<Record<string, number>>((acc, b) => ((acc[b] = (acc[b] ?? 0) + 1), acc), {});
  };

  // 1. triage + plan → the daemon settles at the plan gate with the plan posted
  let child = spawnChild();
  const t0 = Date.now();
  assert.equal(await exited(child), 0, 'daemon settled at the plan gate');
  assert.equal(state(), 'awaiting_plan_approval');
  assert.ok(Object.keys(commentsByKind()).some((k) => /· plan$/.test(k)), 'plan comment posted');
  console.log(`[test] plan posted after ${((Date.now() - t0) / 1000).toFixed(0)}s; requesting a plan change`);

  // 1b. plan feedback → planner resumes its session → revised plan → waits again
  fake.humanComment(issue.id, 'Please also put a data-testid="note-count" on the header element so the test can target it directly.');
  child = spawnChild();
  assert.equal(await exited(child), 0, 'daemon settled after plan revision');
  assert.equal(state(), 'awaiting_plan_approval');
  assert.ok(Object.keys(commentsByKind()).some((k) => /revised plan/.test(k)), 'revised plan posted');
  const revised = JSON.parse(db().getJob(issue.id)!.specJson!);
  console.log(`[test] revised plan: ${revised.summary}`);

  // 1c. approve the plan → building; then crash the daemon mid-worker
  fake.humanComment(issue.id, 'approve');
  child = spawnChild();
  await waitFor(() => state() === 'building', 240_000, 'reach building');
  console.log(`[test] reached building after ${((Date.now() - t0) / 1000).toFixed(0)}s; letting the worker run 12s then SIGKILL`);
  await sleep(12_000);
  process.kill(-child.pid!, 'SIGKILL');
  await sleep(1500);
  assert.equal(state(), 'building', 'state persisted as building across the crash');
  const before = commentsByKind();
  console.log('[test] comments before restart:', before);

  // 2. restart: must resume from building and finish without duplicate comments
  child = spawnChild();
  const code = await exited(child);
  assert.equal(code, 0, 'daemon settled');
  const job = db().getJob(issue.id)!;
  console.log(`[test] final state ${job.state} attempt=${job.attempt} branch=${job.branch} screenshot=${job.screenshotUrl}`);
  assert.equal(job.state, 'awaiting_approval');
  const after = commentsByKind();
  console.log('[test] comments after:', after);
  for (const [k, n] of Object.entries(after)) assert.equal(n, 1, `comment "${k}" posted exactly once`);
  assert.ok(Object.keys(after).some((k) => /ready for review/.test(k)), 'preview comment posted');
  assert.ok(Object.keys(after).some((k) => /built \(attempt 1\)/.test(k)), 'built comment posted');
  // pushed to the bare origin?
  const remoteBranches = execSync(`git --git-dir="${ORIGIN}" branch --list 'agent/*'`).toString().trim();
  assert.match(remoteBranches, /agent\/eng-42/, 'agent branch pushed to origin');
  assert.ok(!execSync(`git --git-dir="${ORIGIN}" log -1 --format=%s main`).toString().includes('ENG-42'), 'main untouched');
  const events = db().listEvents(issue.id).map((e) => `${e.fromState ?? '·'}→${e.toState}${e.note ? ` (${e.note.slice(0, 40)})` : ''}`);
  console.log('[test] events:\n  ' + events.join('\n  '));

  // 3. approve → routed to PR creation (fails here: origin is not GitHub) → failed with gh error
  fake.humanComment(issue.id, 'approve');
  child = spawnChild();
  await exited(child);
  const j2 = db().getJob(issue.id)!;
  console.log(`[test] after approve: ${j2.state} error=${j2.error}`);
  assert.ok(j2.state === 'pr_open' || (j2.state === 'failed' && /gh pr create/.test(j2.error ?? '')), 'approve routed to PR step');
  console.log('\nINTEGRATION OK');
}

function spawnChild() {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'node_modules/.bin/tsx'), fileURLToPath(import.meta.url), '--child'], {
    env: { ...process.env, LINEAR_AGENT_HOME: HOME },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  return c;
}
function exited(c: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((r) => c.on('exit', (code) => r(code)));
}
async function waitFor(pred: () => boolean, timeoutMs: number, what: string) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(1000);
  }
  throw new Error(`timeout waiting to ${what}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
