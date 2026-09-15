// Tiny Chrome DevTools Protocol client over the Node 22 global WebSocket — no Playwright/Puppeteer dependency.
// Used for screenshots of authenticated pages: replay a dev session (cookies + localStorage) captured once by the developer.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from './config.ts';

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
  const pw = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
      for (const sub of ['chrome-mac', 'chrome-mac-arm64']) {
        const bin = path.join(pw, d, sub, 'headless_shell');
        if (fs.existsSync(bin)) return bin;
      }
    }
  }
  return null;
}

export interface AuthState {
  origin: string;
  cookies: { name: string; value: string; path?: string; httpOnly?: boolean; sameSite?: string }[];
  localStorage: Record<string, string>;
  capturedAt: string;
}

export function authFile(projectName: string): string {
  return path.join(PATHS.home, 'preview-auth', `${projectName}.json`);
}
export function loadAuth(projectName: string): AuthState | null {
  const f = authFile(projectName);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as AuthState) : null;
}
export function saveAuth(projectName: string, state: AuthState): string {
  const f = authFile(projectName);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(state, null, 2), { mode: 0o600 });
  return f;
}

// ---------------------------------------------------------------- launch + CDP

export interface Browser {
  child: ChildProcess;
  port: number;
  userDataDir: string;
  kill: () => Promise<void>;
}

export async function launchBrowser(opts: { headless: boolean; url?: string }): Promise<Browser> {
  const bin = findBrowser();
  if (!bin) throw new Error('no Chromium-based browser found (install Chrome/Edge or set LINEAR_AGENT_BROWSER)');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-agent-browser-'));
  const args = ['--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--disable-background-networking'];
  if (opts.headless) args.push('--headless=new', '--disable-gpu', '--hide-scrollbars');
  args.push(opts.url ?? 'about:blank');
  const child = spawn(bin, args, { stdio: 'ignore', detached: true });
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 60_000; // a headed first launch with a fresh profile can be slow
  let port = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const p = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      if (p) {
        port = p;
        break;
      }
    }
    if (child.exitCode !== null) throw new Error(`browser exited early (code ${child.exitCode})`);
    await sleep(150);
  }
  if (!port) throw new Error('browser did not expose a DevTools port');
  const kill = async () => {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      /* gone */
    }
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* gone */
        }
        r();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { child, port, userDataDir, kill };
}

export class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((params: any) => void)[]>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params);
      }
    });
  }

  static async connect(port: number): Promise<Cdp> {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target in browser');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 30_000).unref();
    });
  }

  on(method: string, cb: (params: any) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), cb]);
  }

  /** Navigate, then wait until the document is complete (readyState polling — dev servers don't always fire load cleanly). */
  async navigate(url: string, timeoutMs = 12_000): Promise<void> {
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + timeoutMs;
    await sleep(300);
    while (Date.now() < deadline) {
      try {
        const r = await this.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (r.result.value === 'complete') return;
      } catch {
        /* navigating; context not ready yet */
      }
      await sleep(250);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- high-level operations

/** Screenshot `url`, optionally replaying a captured dev session so authenticated pages render. */
export async function screenshotPage(url: string, outPath: string, auth: AuthState | null): Promise<void> {
  const b = await launchBrowser({ headless: true });
  let cdp: Cdp | null = null;
  try {
    cdp = await Cdp.connect(b.port);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const target = new URL(url);
    if (auth) {
      // Cookies are port-agnostic; localStorage is per origin, so set it once we're on the target origin.
      if (auth.cookies.length) {
        await cdp.send('Network.setCookies', {
          cookies: auth.cookies.map((c) => ({ name: c.name, value: c.value, domain: target.hostname, path: c.path ?? '/', httpOnly: !!c.httpOnly, secure: false })),
        });
      }
      await cdp.navigate(target.origin + '/', 15_000);
      await cdp.send('Runtime.evaluate', {
        expression: `(() => { const o = ${JSON.stringify(auth.localStorage)}; for (const [k, v] of Object.entries(o)) localStorage.setItem(k, v); return Object.keys(o).length; })()`,
        returnByValue: true,
      });
    }
    await cdp.navigate(url);
    await sleep(2000); // let client-side rendering / data fetches settle
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
  } finally {
    cdp?.close();
    await b.kill();
  }
}

export interface AuthCapture {
  /** Read the session from whatever tab is currently on the app's origin, then close the browser. */
  finish: () => Promise<AuthState>;
  cancel: () => Promise<void>;
}

/**
 * Open a visible browser at `url` and let the developer log in. Launch + CDP attach happen here so failures surface
 * immediately; `finish()` captures cookies + localStorage. Tabs are re-listed at finish time because OAuth flows
 * often bounce through popups/redirects — we read from the tab that ended up on the app's origin.
 */
export async function beginAuthCapture(url: string): Promise<AuthCapture> {
  const b = await launchBrowser({ headless: false, url });
  const origin = new URL(url).origin;
  await Cdp.connect(b.port); // fail fast if DevTools isn't reachable
  const pickTab = async (): Promise<Cdp> => {
    const list = (await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const pages = list.filter((t) => t.type === 'page');
    const onApp = pages.find((t) => t.url.startsWith(origin)) ?? pages[0];
    if (!onApp) throw new Error('no browser tab left open');
    const ws = new WebSocket(onApp.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    return new Cdp(ws);
  };
  return {
    finish: async () => {
      let cdp: Cdp | null = null;
      try {
        cdp = await pickTab();
        await cdp.send('Network.enable');
        await cdp.send('Runtime.enable');
        const { cookies } = await cdp.send<{ cookies: any[] }>('Network.getCookies', { urls: [origin + '/'] });
        const ls = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))', returnByValue: true });
        return {
          origin,
          cookies: cookies.map((c) => ({ name: c.name, value: c.value, path: c.path, httpOnly: c.httpOnly, sameSite: c.sameSite })),
          localStorage: JSON.parse(ls.result.value ?? '{}'),
          capturedAt: new Date().toISOString(),
        };
      } finally {
        cdp?.close();
        await b.kill();
      }
    },
    cancel: () => b.kill(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
