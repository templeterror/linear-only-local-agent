// GitHub via the gh CLI (already authenticated on the developer's machine).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './proc.ts';

export async function ghAuthed(): Promise<{ ok: boolean; detail: string }> {
  const r = await run('gh', ['auth', 'status'], { timeoutMs: 20_000 });
  const out = (r.stdout + r.stderr).trim();
  return { ok: r.code === 0, detail: out.split('\n').find((l) => /Logged in/.test(l))?.trim() ?? out.slice(0, 200) };
}

export async function createPr(opts: { worktree: string; base: string; head: string; title: string; body: string }): Promise<string> {
  const bodyFile = path.join(os.tmpdir(), `linear-agent-pr-${Date.now()}.md`);
  fs.writeFileSync(bodyFile, opts.body);
  try {
    const r = await run('gh', ['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body-file', bodyFile], {
      cwd: opts.worktree,
      timeoutMs: 60_000,
    });
    const url = (r.stdout + '\n' + r.stderr).match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
    if (r.code === 0 && url) return url;
    if (/already exists/i.test(r.stderr)) {
      const v = await run('gh', ['pr', 'view', opts.head, '--json', 'url', '-q', '.url'], { cwd: opts.worktree, timeoutMs: 30_000 });
      if (v.code === 0 && v.stdout.trim()) return v.stdout.trim();
    }
    throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}
