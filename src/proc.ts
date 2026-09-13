// Child-process helpers: run-to-completion with timeout + process-group kill,
// and long-lived spawn (dev servers) with the same kill semantics.
import { spawn, type ChildProcess } from 'node:child_process';

export interface RunOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Run through `sh -c`; `cmd` is then the full command line and `args` ignored. */
  shell?: boolean;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Cap on captured output per stream (bytes). Default 2 MB. */
  maxBuffer?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Every live child we spawned; killed on daemon shutdown so no worker outlives the daemon. */
const LIVE = new Set<ChildProcess>();
function track(child: ChildProcess): void {
  LIVE.add(child);
  child.once('close', () => LIVE.delete(child));
  child.once('error', () => LIVE.delete(child));
}
export function killAllChildren(signal: NodeJS.Signals = 'SIGTERM'): number {
  let n = 0;
  for (const c of LIVE) {
    killTree(c, signal);
    n++;
  }
  return n;
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;
  try {
    // Negative pid = the whole process group (we always spawn detached).
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function run(cmd: string, args: string[] = [], opts: RunOpts = {}): Promise<RunResult> {
  const started = Date.now();
  const maxBuffer = opts.maxBuffer ?? 2 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = opts.shell
      ? spawn('/bin/sh', ['-c', cmd], { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    track(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child, 'SIGTERM');
          setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref();
        }, opts.timeoutMs)
      : null;

    const append = (which: 'stdout' | 'stderr', chunk: Buffer) => {
      const s = chunk.toString('utf8');
      opts.onOutput?.(s, which);
      if (which === 'stdout') {
        if (stdout.length < maxBuffer) stdout += s;
      } else if (stderr.length < maxBuffer) stderr += s;
    };
    child.stdout?.on('data', (c) => append('stdout', c));
    child.stderr?.on('data', (c) => append('stderr', c));

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(-1, null);
    });
    child.on('close', finish);

    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

export interface Spawned {
  child: ChildProcess;
  output: () => string;
  kill: () => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Spawn a long-running shell command (e.g. a dev server) in its own process group. */
export function spawnShell(cmdline: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; onOutput?: (s: string) => void } = {}): Spawned {
  const child = spawn('/bin/sh', ['-c', cmdline], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track(child);
  let buf = '';
  const append = (c: Buffer) => {
    const s = c.toString('utf8');
    opts.onOutput?.(s);
    buf = (buf + s).slice(-200_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    child.on('close', (code, signal) => res({ code, signal }));
    child.on('error', () => res({ code: -1, signal: null }));
  });
  return {
    child,
    output: () => buf,
    exited,
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killTree(child, 'SIGTERM');
      const t = setTimeout(() => killTree(child, 'SIGKILL'), 4000);
      await exited;
      clearTimeout(t);
    },
  };
}

export function tail(s: string, lines = 200): string {
  const arr = s.split('\n');
  return arr.slice(Math.max(0, arr.length - lines)).join('\n');
}
