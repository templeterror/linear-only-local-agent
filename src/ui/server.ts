// Minimal local setup UI + JSON API. node:http only; serves ui/index.html.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS, getLinearApiKey, loadEnv, saveEnv, writeProjectConfig, validateConfig } from '../config.ts';
import { addProject, removeProject, setEnabled, loadAllProjects, loadProject, detectDefaults } from '../registry.ts';
import { Linear } from '../linear.ts';
import { doctor } from '../doctor.ts';
import { listModels } from '../models.ts';
import type { Db } from '../db.ts';
import type { Daemon } from '../daemon.ts';
import { log } from '../log.ts';

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

type Handler = (req: http.IncomingMessage, url: URL, body: any) => Promise<unknown>;

export function startUi(opts: { port: number; db: Db; daemon: Daemon }): http.Server {
  const { db, daemon } = opts;
  const linear = () => {
    const key = getLinearApiKey();
    if (!key) throw new HttpError(400, 'Linear API key not configured');
    return new Linear(key);
  };

  const routes: Record<string, Handler> = {
    'GET /api/status': async () => ({ daemon: daemon.status(), home: PATHS.home }),
    'GET /api/settings': async () => {
      const key = getLinearApiKey();
      return { hasLinearKey: !!key, linearKeyMasked: key ? key.slice(0, 8) + '…' + key.slice(-4) : null, envFile: PATHS.env, worktrees: PATHS.worktrees };
    },
    'POST /api/settings': async (_r, _u, body) => {
      if (typeof body?.linearApiKey === 'string' && body.linearApiKey.trim()) {
        const key = body.linearApiKey.trim();
        const viewer = await new Linear(key).viewer(); // validate before saving
        saveEnv({ LINEAR_API_KEY: key });
        return { ok: true, viewer };
      }
      throw new HttpError(400, 'linearApiKey required');
    },
    'GET /api/projects': async () => loadAllProjects(),
    'POST /api/projects': async (_r, _u, body) => {
      const entry = addProject(String(body?.path ?? ''));
      const project = loadProject(entry.path);
      const det = await detectDefaults(entry.path);
      if (!project.hasConfigFile) writeProjectConfig(entry.path, det.config);
      return { project: loadProject(entry.path), detected: det.detected };
    },
    'POST /api/projects/detect': async (_r, _u, body) => detectDefaults(String(body?.path ?? '')),
    'PUT /api/projects/config': async (_r, _u, body) => {
      const p = loadProject(String(body?.path ?? ''));
      const cfg = writeProjectConfig(p.path, body?.config ?? {});
      return { project: loadProject(p.path), errors: validateConfig(cfg) };
    },
    'POST /api/projects/enable': async (_r, _u, body) => {
      const p = loadProject(String(body?.path ?? ''));
      const enabled = !!body?.enabled;
      if (enabled) {
        const errs = validateConfig(p);
        if (errs.length) throw new HttpError(400, 'config invalid: ' + errs.join('; '));
        await linear().ensureLabel(p.linear.teamKey, p.linear.label);
      }
      setEnabled(p.path, enabled);
      log('ui', `${enabled ? 'enabled' : 'disabled'} ${p.name}`);
      return loadProject(p.path);
    },
    'DELETE /api/projects': async (_r, url) => {
      removeProject(url.searchParams.get('path') ?? '');
      return { ok: true };
    },
    'POST /api/doctor': async (_r, _u, body) => doctor(body?.path ? String(body.path) : undefined),
    'GET /api/models': async (_r, url) => listModels(url.searchParams.get('kind') === 'cursor' ? 'cursor' : 'claude'),
    'GET /api/linear/teams': async () => linear().teams(),
    'GET /api/linear/states': async (_r, url) => linear().states(url.searchParams.get('team') ?? ''),
    'GET /api/linear/labels': async (_r, url) => linear().labels(url.searchParams.get('team') ?? ''),
    'GET /api/jobs': async (_r, url) => {
      const p = url.searchParams.get('path');
      return db.listJobs(p ? { projectPath: p } : {}).map((j) => ({ ...j, description: undefined, testOutput: undefined }));
    },
    'GET /api/job': async (_r, url) => {
      const id = url.searchParams.get('id') ?? '';
      const job = db.getJob(id);
      if (!job) throw new HttpError(404, 'no such job');
      return { job, events: db.listEvents(id) };
    },
    'DELETE /api/job': async (_r, url) => {
      const id = url.searchParams.get('id') ?? '';
      if (daemon.status().inFlight.includes(id)) throw new HttpError(409, 'job is running');
      db.deleteJob(id);
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(HTML));
      return;
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    try {
      const body = await readJson(req);
      const out = await handler(req, url, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out ?? null));
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message ?? String(e) }));
    }
  });
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nPort ${opts.port} is already in use — is another \`linear-agent start\` running? (lsof -i :${opts.port}). Set LINEAR_AGENT_UI_PORT to use a different port.\n`);
      process.exit(2);
    }
    throw e;
  });
  server.listen(opts.port, '127.0.0.1', () => log('ui', `setup UI at http://localhost:${opts.port}`));
  return server;
}

class HttpError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'DELETE') return resolve(null);
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export function uiPort(): number {
  return Number(loadEnv().LINEAR_AGENT_UI_PORT ?? 4747) || 4747;
}
