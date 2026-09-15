// Git worktree + branch operations. Every push is guarded: agent branches only, never the base, never --force.
import fs from 'node:fs';
import path from 'node:path';
import { run, type RunResult } from './proc.ts';

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return run('git', ['-C', cwd, ...args], { timeoutMs });
}

async function gitOk(cwd: string, args: string[], what: string): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout;
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', ref]);
  return r.code === 0;
}

export async function ensureWorktree(opts: { repo: string; worktree: string; branch: string; base: string; remote: string }): Promise<{ created: boolean }> {
  const { repo, worktree, branch, base, remote } = opts;
  await git(repo, ['worktree', 'prune']);
  const list = await gitOk(repo, ['worktree', 'list', '--porcelain'], 'worktree list');
  if (list.split('\n').includes(`worktree ${worktree}`)) return { created: false };
  if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true }); // stale, unregistered dir under our own home

  await git(repo, ['fetch', remote, base], 60_000); // best effort
  const start = (await refExists(repo, `${remote}/${base}`)) ? `${remote}/${base}` : base;
  await gitOk(repo, ['worktree', 'add', '-B', branch, worktree, start], 'worktree add');
  return { created: true };
}

/** Add patterns to the repo's private exclude file (.git/info/exclude — shared by all worktrees, never committed). */
export async function excludeInWorktree(worktree: string, patterns: string[]): Promise<void> {
  const p = (await gitOk(worktree, ['rev-parse', '--git-path', 'info/exclude'], 'rev-parse')).trim();
  const abs = path.isAbsolute(p) ? p : path.join(worktree, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const add = patterns.filter((x) => !cur.split('\n').includes(x));
  if (add.length) fs.appendFileSync(abs, (cur.endsWith('\n') || !cur ? '' : '\n') + add.join('\n') + '\n');
}

export async function removeWorktree(repo: string, worktree: string): Promise<void> {
  if (fs.existsSync(worktree)) await git(repo, ['worktree', 'remove', '--force', worktree]);
  await git(repo, ['worktree', 'prune']);
}

/** Delete a local agent branch (never the base branch). The remote branch, if pushed, is left for the human. */
export async function deleteLocalBranch(repo: string, branch: string): Promise<void> {
  if (['main', 'master', 'develop'].includes(branch)) throw new Error(`refusing to delete ${branch}`);
  await git(repo, ['branch', '-D', branch]);
}

/**
 * Stage everything and return the diff. Without `baseRef`: only uncommitted work (what a worker just did).
 * With `baseRef` (e.g. origin/main): everything on the branch, committed or not — what a reviewer should judge.
 */
export async function stageAndDiff(worktree: string, baseRef?: string): Promise<{ diff: string; diffStat: string; files: string[] }> {
  await gitOk(worktree, ['add', '-A'], 'add');
  let from: string[] = [];
  if (baseRef) {
    const mb = await git(worktree, ['merge-base', baseRef, 'HEAD']);
    if (mb.code === 0 && mb.stdout.trim()) from = [mb.stdout.trim()];
  }
  const diff = (await git(worktree, ['diff', '--cached', '--no-color', ...from])).stdout;
  const diffStat = (await git(worktree, ['diff', '--cached', '--stat', '--no-color', ...from])).stdout;
  const files = (await git(worktree, ['diff', '--cached', '--name-only', ...from])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return { diff, diffStat, files };
}

/** Number of commits on HEAD that are not on baseRef. */
export async function commitsAhead(worktree: string, baseRef: string): Promise<number> {
  const r = await git(worktree, ['rev-list', '--count', `${baseRef}..HEAD`]);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

export async function commitAll(worktree: string, message: string): Promise<string | null> {
  await gitOk(worktree, ['add', '-A'], 'add');
  const status = await git(worktree, ['diff', '--cached', '--quiet']);
  if (status.code === 0) return null; // nothing staged
  await gitOk(worktree, ['-c', 'user.name=linear-agent', '-c', 'user.email=linear-agent@local', 'commit', '-q', '-m', message], 'commit');
  return (await gitOk(worktree, ['rev-parse', 'HEAD'], 'rev-parse')).trim();
}

export async function currentBranch(worktree: string): Promise<string> {
  return (await gitOk(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], 'rev-parse')).trim();
}

/** Push the worktree's branch. Refuses anything that is not an agent branch or that equals the base. */
export async function pushBranch(opts: { worktree: string; remote: string; branch: string; base: string; branchPrefix: string }): Promise<void> {
  const { worktree, remote, branch, base, branchPrefix } = opts;
  if (!branch.startsWith(branchPrefix)) throw new Error(`refusing to push non-agent branch ${branch}`);
  if (branch === base || branch === 'main' || branch === 'master') throw new Error(`refusing to push to protected branch ${branch}`);
  const head = await currentBranch(worktree);
  if (head !== branch) throw new Error(`worktree is on ${head}, expected ${branch}`);
  await gitOk(worktree, ['push', '-u', remote, `HEAD:refs/heads/${branch}`], 'push');
}

export async function remoteUrl(repo: string, remote = 'origin'): Promise<string | null> {
  const r = await git(repo, ['remote', 'get-url', remote]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function slugify(s: string, max = 40): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}
