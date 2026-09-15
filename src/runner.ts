// Local verification pipeline: deps → tests → dev server → screenshot. All in the job's worktree.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { run, spawnShell, tail } from './proc.ts';
import { log } from './log.ts';
import { excludeInWorktree } from './git.ts';
import { packageDirs, type Project } from './registry.ts';
import { findBrowser, loadAuth, screenshotPage, type AuthState } from './browser.ts';

/** Untracked env files worth carrying into a worktree so the app runs like it does in the main checkout. */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.test', '.env.test.local'];

/**
 * Make the worktree runnable: symlink every package's node_modules from the main checkout (root + monorepo
 * subdirectories), copy untracked env files, and only fall back to the install command when nothing could be linked.
 */
export async function linkOrInstallDeps(project: Project, worktree: string): Promise<{ method: 'symlink' | 'install' | 'none'; ok: boolean; output: string }> {
  // A symlink is not a directory, so a `node_modules/` gitignore line would not cover it. info/exclude is shared by
  // the whole repo (not per-worktree), so keep this to the one path that is always safe to ignore.
  await excludeInWorktree(worktree, ['node_modules', '**/node_modules', 'venv', '**/venv', '.venv', '**/.venv']);
  const notes: string[] = [];
  let linked = 0;
  let present = 0;
  // Python virtualenvs (backend/venv) are linked like node_modules so `make test` / pytest work in the worktree.
  for (const dir of ['.', ...fs.readdirSync(project.path, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name)]) {
    for (const venv of ['venv', '.venv']) {
      const src = path.join(project.path, dir, venv);
      const dst = path.join(worktree, dir, venv);
      if (fs.existsSync(src) && !fs.existsSync(dst) && fs.existsSync(path.join(worktree, dir))) {
        fs.symlinkSync(src, dst, 'dir');
        notes.push(`linked ${dir}/${venv}`);
      }
    }
  }
  for (const dir of packageDirs(project.path)) {
    const src = path.join(project.path, dir, 'node_modules');
    const dst = path.join(worktree, dir, 'node_modules');
    if (fs.existsSync(dst)) present++;
    else if (fs.existsSync(src) && fs.existsSync(path.join(worktree, dir))) {
      fs.symlinkSync(src, dst, 'dir');
      linked++;
      notes.push(`linked ${dir}/node_modules`);
    }
    for (const f of ENV_FILES) {
      const s = path.join(project.path, dir, f);
      const d = path.join(worktree, dir, f);
      if (fs.existsSync(s) && !fs.existsSync(d) && fs.existsSync(path.join(worktree, dir))) {
        fs.copyFileSync(s, d);
        notes.push(`copied ${dir}/${f}`);
      }
    }
  }
  if (linked || present) return { method: linked ? 'symlink' : 'none', ok: true, output: notes.join(', ') || 'node_modules already present' };
  if (!project.commands.install) return { method: 'none', ok: true, output: 'no install command and no node_modules to link' };
  const r = await run(project.commands.install, [], { cwd: worktree, shell: true, timeoutMs: 10 * 60_000 });
  return { method: 'install', ok: r.code === 0, output: tail(r.stdout + '\n' + r.stderr, 60) };
}

export interface TestResult {
  ran: boolean;
  passed: boolean;
  code: number | null;
  output: string;
  durationMs: number;
}

export async function runTests(project: Project, worktree: string): Promise<TestResult> {
  if (!project.commands.test) return { ran: false, passed: false, code: null, output: '(no test command configured)', durationMs: 0 };
  log('runner', `tests: ${project.commands.test}`);
  const r = await run(project.commands.test, [], { cwd: worktree, shell: true, timeoutMs: project.testTimeoutMin * 60_000, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
  const output = tail(stripAnsi(r.stdout + '\n' + r.stderr), 300);
  return { ran: true, passed: r.code === 0 && !r.timedOut, code: r.timedOut ? null : r.code, output: r.timedOut ? output + '\n[timed out]' : output, durationMs: r.durationMs };
}

export function freePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', () => {
      if (preferred) freePort().then(resolve, reject); // preferred port busy → any free one
      else reject(new Error('no free port'));
    });
    srv.listen(preferred ?? 0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** The port the app conventionally runs on (from devUrl if it is fixed, else the framework default). */
export function conventionalPort(project: Project): number {
  const m = project.commands.devUrl.match(/:(\d{2,5})(\/|$)/);
  return m ? Number(m[1]) : 3000;
}

async function waitForHttp(url: string, timeoutMs: number, isAlive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return false;
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export interface PreviewResult {
  ok: boolean;
  screenshotPath?: string;
  url?: string;
  error?: string;
  devOutput: string;
}

export interface DevServer {
  baseUrl: string;
  port: number;
  output: () => string;
  kill: () => Promise<void>;
}

/** Boot the project's dev server on a free port from `cwd` and wait until it answers. */
export async function bootDevServer(project: Project, cwd: string, opts: { preferredPort?: number } = {}): Promise<{ ok: true; server: DevServer } | { ok: false; error: string; devOutput: string }> {
  if (!project.commands.dev) return { ok: false, error: 'no dev command configured', devOutput: '' };
  const port = await freePort(opts.preferredPort);
  const cmd = project.commands.dev.replace(/\{port\}/g, String(port));
  const base = project.commands.devUrl.replace(/\{port\}/g, String(port)).replace(/\/$/, '');
  const readyUrl = base + (project.commands.devReadyPath || '/');
  log('runner', `dev server: ${cmd} (port ${port})`);
  const proc = spawnShell(cmd, { cwd, env: { ...process.env, PORT: String(port), BROWSER: 'none', CI: '1', FORCE_COLOR: '0' } });
  let alive = true;
  proc.exited.then(() => (alive = false));
  const up = await waitForHttp(readyUrl, project.devBootTimeoutSec * 1000, () => alive);
  if (!up) {
    const devOutput = tail(stripAnsi(proc.output()), 80);
    await proc.kill();
    return { ok: false, error: alive ? `dev server not ready after ${project.devBootTimeoutSec}s` : 'dev server exited early', devOutput };
  }
  return { ok: true, server: { baseUrl: base, port, output: () => proc.output(), kill: proc.kill } };
}

/** Boot the dev server on a free port, wait for readiness, screenshot the route (replaying the developer's saved login if any), tear down. */
export async function bootAndScreenshot(project: Project, worktree: string, route: string, outPath: string): Promise<PreviewResult> {
  const boot = await bootDevServer(project, worktree);
  if (!boot.ok) return { ok: false, error: boot.error, devOutput: boot.devOutput };
  const { server } = boot;
  const targetUrl = server.baseUrl + (route && route.startsWith('/') ? route : project.commands.devReadyPath || '/');
  try {
    await new Promise((r) => setTimeout(r, 1500)); // give client-side rendering a moment
    const shot = await screenshot(targetUrl, outPath, loadAuth(project.name));
    if (!shot.ok) return { ok: false, error: shot.error, url: targetUrl, devOutput: tail(stripAnsi(server.output()), 80) };
    return { ok: true, screenshotPath: outPath, url: targetUrl, devOutput: tail(stripAnsi(server.output()), 40) };
  } finally {
    await server.kill();
  }
}

export { findBrowser } from './browser.ts';

/** Screenshot via CDP (supports replaying a saved login); falls back to Chrome's --screenshot flag. */
export async function screenshot(url: string, outPath: string, auth: AuthState | null = null): Promise<{ ok: boolean; error?: string; authed?: boolean }> {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: 'no Chromium-based browser found for screenshots' };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    await screenshotPage(url, outPath, auth);
    if (fs.existsSync(outPath)) return { ok: true, authed: !!auth };
  } catch (e: any) {
    log('runner', `CDP screenshot failed (${e.message}); falling back to --screenshot`);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-agent-chrome-'));
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1280,800', '--virtual-time-budget=8000', `--screenshot=${outPath}`, url];
  const r = await run(browser, args, { timeoutMs: 60_000 });
  fs.rmSync(profile, { recursive: true, force: true });
  if (!fs.existsSync(outPath)) return { ok: false, error: `screenshot failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
  return { ok: true, authed: false };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
