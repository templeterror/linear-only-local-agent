// Minimal Linear GraphQL client (native fetch, no SDK).
const ENDPOINT = 'https://api.linear.app/graphql';

export interface LinearUser {
  id: string;
  name: string;
  email?: string;
}
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}
export interface LinearState {
  id: string;
  name: string;
  type: string;
  position: number;
}
export interface LinearLabel {
  id: string;
  name: string;
}
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  labels: { nodes: LinearLabel[] };
  assignee: { id: string } | null;
  team: { id: string; key: string };
}
export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string } | null;
  botActor: { id: string; name: string } | null;
}

export class LinearError extends Error {}

export class Linear {
  constructor(private apiKey: string) {}

  async gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LinearError(`Linear HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.ok || json.errors?.length) {
      const msg = json.errors?.map((e: any) => e.message).join('; ') ?? `HTTP ${res.status}`;
      throw new LinearError(`Linear: ${msg}`);
    }
    return json.data as T;
  }

  async viewer(): Promise<LinearUser> {
    const d = await this.gql<{ viewer: LinearUser }>('{ viewer { id name email } }');
    return d.viewer;
  }

  async teams(): Promise<LinearTeam[]> {
    const d = await this.gql<{ teams: { nodes: LinearTeam[] } }>('{ teams(first: 100) { nodes { id key name } } }');
    return d.teams.nodes;
  }

  async team(teamKey: string): Promise<LinearTeam> {
    const t = (await this.teams()).find((x) => x.key === teamKey);
    if (!t) throw new LinearError(`team not found: ${teamKey}`);
    return t;
  }

  async states(teamKey: string): Promise<LinearState[]> {
    const d = await this.gql<{ teams: { nodes: { states: { nodes: LinearState[] } }[] } }>(
      `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { states { nodes { id name type position } } } } }`,
      { key: teamKey },
    );
    const nodes = d.teams.nodes[0]?.states.nodes ?? [];
    return nodes.sort((a, b) => a.position - b.position);
  }

  async labels(teamKey: string): Promise<LinearLabel[]> {
    // Team labels + workspace labels (team: null)
    const d = await this.gql<{ issueLabels: { nodes: (LinearLabel & { team: { key: string } | null })[] } }>(
      `{ issueLabels(first: 250) { nodes { id name team { key } } } }`,
    );
    return d.issueLabels.nodes.filter((l) => !l.team || l.team.key === teamKey).map((l) => ({ id: l.id, name: l.name }));
  }

  async ensureLabel(teamKey: string, name: string): Promise<LinearLabel> {
    const existing = (await this.labels(teamKey)).find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const team = await this.team(teamKey);
    const d = await this.gql<{ issueLabelCreate: { success: boolean; issueLabel: LinearLabel } }>(
      `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`,
      { input: { name, teamId: team.id, color: '#5e6ad2' } },
    );
    return d.issueLabelCreate.issueLabel;
  }

  /** Open issues in a team carrying the trigger label. */
  async candidateIssues(teamKey: string, label: string, opts: { assigneeId?: string } = {}): Promise<LinearIssue[]> {
    const filter: any = {
      team: { key: { eq: teamKey } },
      labels: { name: { eqIgnoreCase: label } },
      state: { type: { nin: ['completed', 'canceled'] } },
    };
    if (opts.assigneeId) filter.assignee = { id: { eq: opts.assigneeId } };
    const d = await this.gql<{ issues: { nodes: LinearIssue[] } }>(
      `query($filter: IssueFilter!) { issues(filter: $filter, first: 50, orderBy: updatedAt) { nodes ${ISSUE_FIELDS} } }`,
      { filter },
    );
    return d.issues.nodes;
  }

  async issue(id: string): Promise<LinearIssue | null> {
    try {
      const d = await this.gql<{ issue: LinearIssue }>(`query($id: String!) { issue(id: $id) ${ISSUE_FIELDS} }`, { id });
      return d.issue;
    } catch (e) {
      if (e instanceof LinearError && /not found|Entity not found/i.test(e.message)) return null;
      throw e;
    }
  }

  async comments(issueId: string): Promise<LinearComment[]> {
    const d = await this.gql<{ issue: { comments: { nodes: LinearComment[] } } }>(
      `query($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id body createdAt user { id name } botActor { id name } } } } }`,
      { id: issueId },
    );
    return d.issue.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    const d = await this.gql<{ commentCreate: { success: boolean; comment: { id: string } } }>(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`,
      { input: { issueId, body } },
    );
    return d.commentCreate.comment;
  }

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, {
      id: issueId,
      input: { stateId },
    });
  }

  async attachLink(issueId: string, url: string, title: string): Promise<void> {
    await this.gql(`mutation($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }`, {
      issueId,
      url,
      title,
    });
  }

  /** Upload a file to Linear's asset storage; returns the asset URL usable in markdown. */
  async uploadFile(filename: string, contentType: string, data: Buffer): Promise<string> {
    const d = await this.gql<{ fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } } }>(
      `mutation($contentType: String!, $filename: String!, $size: Int!) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`,
      { contentType, filename, size: data.length },
    );
    const up = d.fileUpload.uploadFile;
    const headers: Record<string, string> = { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000' };
    for (const h of up.headers) headers[h.key] = h.value;
    const res = await fetch(up.uploadUrl, { method: 'PUT', headers, body: new Uint8Array(data) });
    if (!res.ok) throw new LinearError(`asset upload failed: HTTP ${res.status}`);
    return up.assetUrl;
  }

  async createIssue(teamKey: string, input: { title: string; description?: string; labelNames?: string[] }): Promise<{ id: string; identifier: string; url: string }> {
    const team = await this.team(teamKey);
    const labelIds: string[] = [];
    for (const n of input.labelNames ?? []) labelIds.push((await this.ensureLabel(teamKey, n)).id);
    const d = await this.gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } } }>(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
      { input: { teamId: team.id, title: input.title, description: input.description ?? '', labelIds } },
    );
    return d.issueCreate.issue;
  }
}

const ISSUE_FIELDS = `{
  id identifier title description url branchName updatedAt
  state { id name type }
  labels { nodes { id name } }
  assignee { id }
  team { id key }
}`;
