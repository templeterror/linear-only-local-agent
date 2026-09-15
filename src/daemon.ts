// The daemon loop: poll Linear for every enabled project → ingest new tickets → route human comments → run steps.
// Deterministic, restart-safe: all state lives in SQLite; `inFlight` is the only in-memory state.
import { Db } from './db.ts';
import { Linear } from './linear.ts';
import { getLinearApiKey } from './config.ts';
import { loadEnabledProjects, type Project } from './registry.ts';
import { ACTIVE_STATES, IDLE_STATES, TERMINAL_STATES } from './state.ts';
import { isAgentComment } from './comments.ts';
import { runStep, handleHumanComment, type Ctx } from './steps.ts';
import { killAllChildren } from './proc.ts';
import { log } from './log.ts';

export interface DaemonStatus {
  running: boolean;
  ticks: number;
  lastTickAt: string | null;
  lastError: string | null;
  inFlight: string[];
}

export class Daemon {
  private inFlight = new Map<string, Promise<void>>();
  private stopping = false;
  private ticks = 0;
  private lastTickAt: string | null = null;
  private lastError: string | null = null;
  private linear: Linear | null = null;
  private linearKey: string | null = null;
  private viewerId: string | null = null;

  constructor(
    private db: Db,
    private projects: () => Project[] = loadEnabledProjects,
    /** Test hook: use this client instead of one built from LINEAR_API_KEY. */
    private linearOverride: Linear | null = null,
  ) {}

  status(): DaemonStatus {
    return { running: !this.stopping, ticks: this.ticks, lastTickAt: this.lastTickAt, lastError: this.lastError, inFlight: [...this.inFlight.keys()] };
  }

  private client(): Linear | null {
    if (this.linearOverride) return this.linearOverride;
    const key = getLinearApiKey();
    if (!key) return null;
    if (!this.linear || this.linearKey !== key) {
      this.linear = new Linear(key);
      this.linearKey = key;
      this.viewerId = null;
    }
    return this.linear;
  }

  async tick(): Promise<void> {
    this.ticks++;
    this.lastTickAt = new Date().toISOString();
    const linear = this.client();
    if (!linear) {
      this.lastError = 'no LINEAR_API_KEY configured';
      return;
    }
    try {
      if (!this.viewerId) this.viewerId = (await linear.viewer()).id;
      this.lastError = null;
    } catch (e: any) {
      this.lastError = `Linear auth failed: ${e.message}`;
      log('daemon', this.lastError);
      return;
    }
    for (const project of this.projects()) {
      try {
        await this.pollProject({ db: this.db, linear, project });
      } catch (e: any) {
        this.lastError = `${project.name}: ${e.message}`;
        log('daemon', `poll ${project.name} failed: ${e.message}`);
      }
    }
  }

  private async pollProject(ctx: Ctx): Promise<void> {
    const { db, linear, project } = ctx;

    // 1. Ingest: every open issue with the trigger label becomes a job exactly once.
    const issues = await linear.candidateIssues(project.linear.teamKey, project.linear.label, project.linear.assigneeOnly ? { assigneeId: this.viewerId! } : {});
    const candidateIds = new Set(issues.map((i) => i.id));
    for (const issue of issues) {
      const existing = db.getJob(issue.id);
      // Optional per-ticket routing: a `worker:claude` / `worker:cursor` label overrides the project's worker.
      const wk = issue.labels.nodes.map((l) => l.name.toLowerCase()).find((n) => n === 'worker:claude' || n === 'worker:cursor')?.slice(7) as 'claude' | 'cursor' | undefined;
      if (existing) {
        // Label was removed after a failure/decline and is now back: the human asked for a retry.
        if (existing.archived && (existing.state === 'failed' || existing.state === 'declined')) {
          db.resetJob(issue.id, 'retry: label re-added');
          db.updateJob(issue.id, { workerKind: wk ?? null, title: issue.title, description: issue.description });
          log('daemon', `${issue.identifier} retry requested via label`);
        }
        continue;
      }
      db.createJob({ issueId: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description, url: issue.url, projectPath: project.path, workerKind: wk ?? null });
      log('daemon', `new job ${issue.identifier} "${issue.title}" (${project.name}${wk ? `, worker=${wk}` : ''})`);
    }

    // 2. Label removed / issue closed: cancel active jobs; mark finished ones so a re-added label restarts them.
    for (const job of db.listJobs({ projectPath: project.path })) {
      if (candidateIds.has(job.issueId) || this.inFlight.has(job.issueId)) continue;
      if (TERMINAL_STATES.includes(job.state)) {
        if (!job.archived) db.updateJob(job.issueId, { archived: 1 });
        continue;
      }
      // Jobs we moved to the review state stay candidates (label is still on); only real removals land here.
      db.transition(job.issueId, 'declined', 'label removed or issue closed in Linear', { archived: 1 });
      log('daemon', `${job.identifier} cancelled (label removed / issue closed)`);
    }

    // 3. Human replies: idle jobs (question / approval), finished jobs still carrying the label, and paused jobs
    //    (usage limit) — so `-tryagain-` / `-startover-` can release or restart them.
    const listening = db.listJobs({ projectPath: project.path }).filter((j) => IDLE_STATES.includes(j.state) || (TERMINAL_STATES.includes(j.state) && candidateIds.has(j.issueId)) || (ACTIVE_STATES.includes(j.state) && !!j.retryAfter));
    for (const job of listening) {
      if (this.inFlight.has(job.issueId)) continue;
      const comments = await linear.comments(job.issueId);
      const fresh = comments.filter((c) => !db.isSeen(c.id));
      const human = fresh.filter((c) => !isAgentComment(c.body) && !db.isAgentComment(c.id) && c.createdAt > job.createdAt && !c.botActor);
      for (const c of fresh) db.markSeen(job.issueId, c.id);
      const latest = human[human.length - 1];
      if (latest) this.launch(job.issueId, () => handleHumanComment(ctx, job.issueId, latest));
    }

    // 4. Dispatch active steps within the concurrency cap.
    const busy = db.listJobs({ projectPath: project.path }).filter((j) => this.inFlight.has(j.issueId)).length;
    let slots = Math.max(0, project.concurrency - busy);
    const now = new Date().toISOString();
    for (const job of db.listJobs({ projectPath: project.path, states: ACTIVE_STATES })) {
      if (slots <= 0) break;
      if (this.inFlight.has(job.issueId)) continue;
      if (job.retryAfter) {
        if (job.retryAfter > now) continue; // paused on a usage limit
        db.updateJob(job.issueId, { retryAfter: null });
        log('daemon', `${job.identifier} resuming ${job.state} after pause`);
      }
      this.launch(job.issueId, () => runStep(ctx, job.issueId));
      slots--;
    }
  }

  private launch(key: string, fn: () => Promise<void>): void {
    if (this.inFlight.has(key)) return;
    const p = fn()
      .catch((e) => log('daemon', `step ${key} threw: ${e?.message ?? e}`))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
  }

  /** Run one poll cycle and wait for every step it launched (used by `once` and tests). */
  async once(): Promise<void> {
    await this.tick();
    await Promise.all([...this.inFlight.values()]);
  }

  async run(): Promise<void> {
    const onSignal = () => {
      if (this.stopping) return;
      this.stopping = true;
      const n = killAllChildren();
      log('daemon', `shutting down (killed ${n} child processes); in-flight steps will resume on next start`);
      setTimeout(() => process.exit(0), 1500).unref();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    log('daemon', `started; projects: ${this.projects().map((p) => `${p.name}[${p.linear.teamKey}/${p.linear.label}]`).join(', ') || '(none enabled)'}`);
    while (!this.stopping) {
      await this.tick();
      const secs = Math.min(...this.projects().map((p) => p.pollSeconds), 300) || 25;
      await new Promise((r) => setTimeout(r, (Number.isFinite(secs) ? secs : 25) * 1000));
    }
  }
}
