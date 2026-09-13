// In-memory Linear stand-in for integration tests, persisted to a JSON file so it survives a daemon "crash".
import fs from 'node:fs';
import type { Linear, LinearIssue, LinearComment, LinearState, LinearTeam, LinearLabel } from '../src/linear.ts';

interface Store {
  issues: LinearIssue[];
  comments: Record<string, LinearComment[]>;
  issueStates: Record<string, string>;
  attachments: Record<string, { url: string; title: string }[]>;
  uploads: string[];
}

const STATES: LinearState[] = [
  { id: 'st-backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 'st-progress', name: 'In Progress', type: 'started', position: 2 },
  { id: 'st-review', name: 'In Review', type: 'started', position: 3 },
  { id: 'st-done', name: 'Done', type: 'completed', position: 4 },
];

export class FakeLinear {
  readonly viewerId = 'user-dev';
  private store: Store;
  constructor(private file: string) {
    this.store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { issues: [], comments: {}, issueStates: {}, attachments: {}, uploads: [] };
  }
  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.store, null, 2));
  }
  asLinear(): Linear {
    return this as unknown as Linear;
  }

  // ---- test helpers ----
  addIssue(input: { identifier: string; title: string; description: string; label?: string; teamKey?: string }): LinearIssue {
    const issue: LinearIssue = {
      id: `issue-${input.identifier}`,
      identifier: input.identifier,
      title: input.title,
      description: input.description,
      url: `https://linear.app/fake/issue/${input.identifier}`,
      branchName: input.identifier.toLowerCase(),
      updatedAt: new Date().toISOString(),
      state: STATES[1] as any,
      labels: { nodes: [{ id: 'lbl-agent', name: input.label ?? 'agent' }] },
      assignee: null,
      team: { id: 'team-1', key: input.teamKey ?? 'ENG' },
    };
    this.store.issues.push(issue);
    this.store.comments[issue.id] = [];
    this.save();
    return issue;
  }
  humanComment(issueId: string, body: string): LinearComment {
    const c: LinearComment = { id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, body, createdAt: new Date().toISOString(), user: { id: this.viewerId, name: 'Dev' }, botActor: null };
    this.store.comments[issueId].push(c);
    this.save();
    return c;
  }
  removeLabel(issueId: string) {
    const i = this.store.issues.find((x) => x.id === issueId);
    if (i) i.labels = { nodes: [] };
    this.save();
  }
  dump() {
    return structuredClone(this.store);
  }

  // ---- Linear API surface used by the daemon ----
  async viewer() {
    return { id: this.viewerId, name: 'Dev', email: 'dev@example.com' };
  }
  async teams(): Promise<LinearTeam[]> {
    return [{ id: 'team-1', key: 'ENG', name: 'Engineering' }];
  }
  async team(key: string): Promise<LinearTeam> {
    return { id: 'team-1', key, name: 'Engineering' };
  }
  async states(_teamKey: string): Promise<LinearState[]> {
    return STATES;
  }
  async labels(): Promise<LinearLabel[]> {
    return [{ id: 'lbl-agent', name: 'agent' }];
  }
  async ensureLabel(_t: string, name: string): Promise<LinearLabel> {
    return { id: 'lbl-agent', name };
  }
  async candidateIssues(teamKey: string, label: string): Promise<LinearIssue[]> {
    return this.store.issues.filter((i) => i.team.key === teamKey && i.labels.nodes.some((l) => l.name === label) && !['completed', 'canceled'].includes(i.state.type));
  }
  async issue(id: string) {
    return this.store.issues.find((i) => i.id === id) ?? null;
  }
  async comments(issueId: string): Promise<LinearComment[]> {
    return [...(this.store.comments[issueId] ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    const c: LinearComment = { id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, body, createdAt: new Date().toISOString(), user: { id: this.viewerId, name: 'Dev' }, botActor: null };
    (this.store.comments[issueId] ??= []).push(c);
    this.save();
    return { id: c.id };
  }
  async updateIssueState(issueId: string, stateId: string) {
    this.store.issueStates[issueId] = stateId;
    const i = this.store.issues.find((x) => x.id === issueId);
    const st = STATES.find((s) => s.id === stateId);
    if (i && st) i.state = st as any;
    this.save();
  }
  async attachLink(issueId: string, url: string, title: string) {
    (this.store.attachments[issueId] ??= []).push({ url, title });
    this.save();
  }
  async uploadFile(filename: string, _ct: string, data: Buffer): Promise<string> {
    this.store.uploads.push(`${filename} (${data.length} bytes)`);
    this.save();
    return `https://uploads.fake/${filename}`;
  }
  async createIssue(): Promise<never> {
    throw new Error('not supported in fake');
  }
}
