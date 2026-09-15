// SQLite persistence (node:sqlite, built into Node 22). One row per Linear issue.
import { DatabaseSync } from 'node:sqlite';
import { PATHS, ensureHome } from './config.ts';
import { assertTransition, type State } from './state.ts';

export interface Job {
  issueId: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
  projectPath: string;
  state: State;
  attempt: number;
  /** Per-ticket worker override from a `worker:<kind>` label; null = project default. */
  workerKind: 'cursor' | 'claude' | null;
  /** ISO time before which the daemon must not run this job (usage-limit pause). */
  retryAfter: string | null;
  /** 1 once the trigger label was removed from a finished job; re-adding the label then restarts it. */
  archived: number | null;
  worktree: string | null;
  branch: string | null;
  plannerSessionId: string | null;
  workerSessionId: string | null;
  specJson: string | null;
  fixInstructions: string | null;
  diffSummary: string | null;
  testOutput: string | null;
  testPassed: number | null;
  screenshotUrl: string | null;
  migrationSql: string | null;
  prUrl: string | null;
  error: string | null;
  lastCommentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobEvent {
  id: number;
  issueId: string;
  fromState: string | null;
  toState: string;
  note: string | null;
  at: string;
}

const COLS: Record<keyof Job, string> = {
  issueId: 'issue_id',
  identifier: 'identifier',
  title: 'title',
  description: 'description',
  url: 'url',
  projectPath: 'project_path',
  state: 'state',
  attempt: 'attempt',
  workerKind: 'worker_kind',
  retryAfter: 'retry_after',
  archived: 'archived',
  worktree: 'worktree',
  branch: 'branch',
  plannerSessionId: 'planner_session_id',
  workerSessionId: 'worker_session_id',
  specJson: 'spec_json',
  fixInstructions: 'fix_instructions',
  diffSummary: 'diff_summary',
  testOutput: 'test_output',
  testPassed: 'test_passed',
  screenshotUrl: 'screenshot_url',
  migrationSql: 'migration_sql',
  prUrl: 'pr_url',
  error: 'error',
  lastCommentAt: 'last_comment_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  issue_id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  url TEXT,
  project_path TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  worker_kind TEXT,
  retry_after TEXT,
  archived INTEGER,
  worktree TEXT,
  branch TEXT,
  planner_session_id TEXT,
  worker_session_id TEXT,
  spec_json TEXT,
  fix_instructions TEXT,
  diff_summary TEXT,
  test_output TEXT,
  test_passed INTEGER,
  screenshot_url TEXT,
  migration_sql TEXT,
  pr_url TEXT,
  error TEXT,
  last_comment_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_issue ON events(issue_id, id);
CREATE TABLE IF NOT EXISTS agent_comments (
  comment_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_comments (
  comment_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  at TEXT NOT NULL
);
`;

function rowToJob(r: any): Job {
  const j: any = {};
  for (const [k, col] of Object.entries(COLS)) j[k] = r[col] ?? null;
  return j as Job;
}

export class Db {
  private db: DatabaseSync;

  constructor(file: string = PATHS.db) {
    if (file !== ':memory:') ensureHome();
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive schema migrations for databases created by earlier versions. */
  private migrate(): void {
    const cols = new Set((this.db.prepare('PRAGMA table_info(jobs)').all() as any[]).map((r) => r.name));
    for (const [k, col] of Object.entries(COLS)) {
      if (!cols.has(col)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${['attempt', 'testPassed', 'archived'].includes(k) ? 'INTEGER' : 'TEXT'}`);
    }
  }

  close(): void {
    this.db.close();
  }

  getJob(issueId: string): Job | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE issue_id = ?').get(issueId);
    return r ? rowToJob(r) : null;
  }

  listJobs(opts: { projectPath?: string; states?: readonly State[] } = {}): Job[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.projectPath) {
      where.push('project_path = ?');
      params.push(opts.projectPath);
    }
    if (opts.states && opts.states.length) {
      where.push(`state IN (${opts.states.map(() => '?').join(',')})`);
      params.push(...opts.states);
    }
    const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToJob);
  }

  createJob(input: Pick<Job, 'issueId' | 'identifier' | 'title' | 'description' | 'url' | 'projectPath'> & { workerKind?: Job['workerKind'] }): Job {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (issue_id, identifier, title, description, url, project_path, state, attempt, worker_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(input.issueId, input.identifier, input.title, input.description, input.url, input.projectPath, input.workerKind ?? null, now, now);
    this.db.prepare('INSERT INTO events (issue_id, from_state, to_state, note, at) VALUES (?, NULL, ?, ?, ?)').run(input.issueId, 'queued', 'picked up', now);
    return this.getJob(input.issueId)!;
  }

  updateJob(issueId: string, patch: Partial<Omit<Job, 'issueId' | 'state' | 'createdAt'>>): Job {
    const sets: string[] = [];
    const params: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = (COLS as any)[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      params.push(v);
    }
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(issueId);
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE issue_id = ?`).run(...params);
    return this.getJob(issueId)!;
  }

  /** Validated state transition + audit event. */
  transition(issueId: string, to: State, note?: string, patch: Partial<Omit<Job, 'issueId' | 'state' | 'createdAt'>> = {}): Job {
    const job = this.getJob(issueId);
    if (!job) throw new Error(`no job ${issueId}`);
    assertTransition(job.state, to);
    const now = new Date().toISOString();
    this.updateJob(issueId, patch);
    this.db.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE issue_id = ?').run(to, now, issueId);
    this.db.prepare('INSERT INTO events (issue_id, from_state, to_state, note, at) VALUES (?, ?, ?, ?, ?)').run(issueId, job.state, to, note ?? null, now);
    return this.getJob(issueId)!;
  }

  /** Human-commanded jump to a state, bypassing the transition table (e.g. failed → building for "try again"). */
  forceState(issueId: string, to: State, note: string, patch: Partial<Omit<Job, 'issueId' | 'state' | 'createdAt'>> = {}): Job {
    const job = this.getJob(issueId);
    if (!job) throw new Error(`no job ${issueId}`);
    const now = new Date().toISOString();
    this.updateJob(issueId, patch);
    this.db.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE issue_id = ?').run(to, now, issueId);
    this.db.prepare('INSERT INTO events (issue_id, from_state, to_state, note, at) VALUES (?, ?, ?, ?, ?)').run(issueId, job.state, to, note, now);
    return this.getJob(issueId)!;
  }

  /** Start a finished (failed/declined) job over from `queued`, keeping its worktree and history. */
  resetJob(issueId: string, note: string): Job {
    const job = this.getJob(issueId);
    if (!job) throw new Error(`no job ${issueId}`);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET state = 'queued', attempt = 0, error = NULL, fix_instructions = NULL, retry_after = NULL, archived = 0,
         planner_session_id = NULL, worker_session_id = NULL, spec_json = NULL, pr_url = NULL, updated_at = ? WHERE issue_id = ?`,
      )
      .run(now, issueId);
    this.db.prepare('INSERT INTO events (issue_id, from_state, to_state, note, at) VALUES (?, ?, ?, ?, ?)').run(issueId, job.state, 'queued', note, now);
    return this.getJob(issueId)!;
  }

  addEvent(issueId: string, note: string): void {
    const job = this.getJob(issueId);
    this.db
      .prepare('INSERT INTO events (issue_id, from_state, to_state, note, at) VALUES (?, ?, ?, ?, ?)')
      .run(issueId, job?.state ?? null, job?.state ?? 'unknown', note, new Date().toISOString());
  }

  listEvents(issueId: string): JobEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE issue_id = ? ORDER BY id ASC').all(issueId) as any[]).map((r) => ({
      id: r.id,
      issueId: r.issue_id,
      fromState: r.from_state,
      toState: r.to_state,
      note: r.note,
      at: r.at,
    }));
  }

  recordAgentComment(issueId: string, commentId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO agent_comments (comment_id, issue_id, at) VALUES (?, ?, ?)').run(commentId, issueId, new Date().toISOString());
  }

  isAgentComment(commentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM agent_comments WHERE comment_id = ?').get(commentId);
  }

  markSeen(issueId: string, commentId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO seen_comments (comment_id, issue_id, at) VALUES (?, ?, ?)').run(commentId, issueId, new Date().toISOString());
  }

  isSeen(commentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen_comments WHERE comment_id = ?').get(commentId);
  }

  deleteJob(issueId: string): void {
    this.db.prepare('DELETE FROM jobs WHERE issue_id = ?').run(issueId);
    this.db.prepare('DELETE FROM events WHERE issue_id = ?').run(issueId);
  }
}
