// Local verification pipeline: deps → tests → dev server → screenshot. All in the job's worktree.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { run, spawnShell, tail } from './proc.ts';
import { log } from './log.ts';
import { excludeInWorktree } from './git.ts';
import { packageDirs, type Project } from './registry.ts';

/** Untracked env files worth carrying into a worktree so the app runs like it does in the main checkout. */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.test', '.env.test.local'];

/**
 * Make the worktree runnable: symlink every package's node_modules from the main checkout (root + monorepo
 * subdirectories), copy untracked env files, and only fall back to the install command when nothing could be linked.
 */
export async function linkOrInstallDeps(project: Project, worktree: string): Promise<{ method: 'symlink' | 'install' | 'none'; ok: boolean; output: string }> {
  // A symlink is not a directory, so a `node_modules/` gitignore line would not cover it. info/exclude is shared by
  // the whole repo (not per-worktree), so keep this to the one path that is always safe to ignore.
  await excludeInWorktree(worktree, ['node_modules', '**/node_modules']);
  const notes: string[] = [];
  let linked = 0;
  let present = 0;
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

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
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

/** Boot the dev server on a free port, wait for readiness, screenshot the route, tear down. */
export async function bootAndScreenshot(project: Project, worktree: string, route: string, outPath: string): Promise<PreviewResult> {
  if (!project.commands.dev) return { ok: false, error: 'no dev command configured', devOutput: '' };
  const port = await freePort();
  const cmd = project.commands.dev.replace(/\{port\}/g, String(port));
  const base = project.commands.devUrl.replace(/\{port\}/g, String(port)).replace(/\/$/, '');
  const readyUrl = base + (project.commands.devReadyPath || '/');
  const targetUrl = base + (route && route.startsWith('/') ? route : project.commands.devReadyPath || '/');
  log('runner', `dev server: ${cmd} (port ${port})`);
  const proc = spawnShell(cmd, { cwd: worktree, env: { ...process.env, PORT: String(port), BROWSER: 'none', CI: '1', FORCE_COLOR: '0' } });
  let alive = true;
  proc.exited.then(() => (alive = false));
  try {
    const up = await waitForHttp(readyUrl, project.devBootTimeoutSec * 1000, () => alive);
    if (!up) return { ok: false, error: alive ? `dev server not ready after ${project.devBootTimeoutSec}s` : 'dev server exited early', devOutput: tail(stripAnsi(proc.output()), 80) };
    // give client-side rendering a moment
    await new Promise((r) => setTimeout(r, 1500));
    const shot = await screenshot(targetUrl, outPath);
    if (!shot.ok) return { ok: false, error: shot.error, url: targetUrl, devOutput: tail(stripAnsi(proc.output()), 80) };
    return { ok: true, screenshotPath: outPath, url: targetUrl, devOutput: tail(stripAnsi(proc.output()), 40) };
  } finally {
    await proc.kill();
  }
}

const BROWSER_CANDIDATES = [
  process.env.LINEAR_AGENT_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Arc.app/Contents/MacOS/Arc',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[];

export function findBrowser(): string | null {
  for (const c of BROWSER_CANDIDATES) if (fs.existsSync(c)) return c;
  // Playwright's cached headless shell, if any
  const pw = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (fs.existsSync(pw)) {
    const dirs = fs.readdirSync(pw).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse();
    for (const d of dirs) {
      const bin = path.join(pw, d, 'chrome-mac', 'headless_shell');
      if (fs.existsSync(bin)) return bin;
      const bin2 = path.join(pw, d, 'chrome-mac-arm64', 'headless_shell');
      if (fs.existsSync(bin2)) return bin2;
    }
  }
  return null;
}

export async function screenshot(url: string, outPath: string): Promise<{ ok: boolean; error?: string }> {
  const browser = findBrowser();
  if (!browser) return { ok: false, error: 'no Chromium-based browser found for screenshots' };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-agent-chrome-'));
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1280,800', '--virtual-time-budget=8000', `--screenshot=${outPath}`, url];
  const r = await run(browser, args, { timeoutMs: 60_000 });
  fs.rmSync(profile, { recursive: true, force: true });
  if (!fs.existsSync(outPath)) return { ok: false, error: `screenshot failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
  return { ok: true };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
