// Global daemon home (~/.linear-agent) + per-project config (.linear-agent.json).
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export const HOME = process.env.LINEAR_AGENT_HOME || path.join(homedir(), '.linear-agent');
export const PATHS = {
  home: HOME,
  env: path.join(HOME, '.env'),
  registry: path.join(HOME, 'projects.json'),
  db: path.join(HOME, 'state.db'),
  worktrees: path.join(HOME, 'worktrees'),
  logs: path.join(HOME, 'logs'),
  artifacts: path.join(HOME, 'artifacts'),
};

export const PROJECT_CONFIG_FILE = '.linear-agent.json';

export function ensureHome(): void {
  for (const p of [PATHS.home, PATHS.worktrees, PATHS.logs, PATHS.artifacts]) fs.mkdirSync(p, { recursive: true });
}

// ---------- global env (.env in HOME) ----------

export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (fs.existsSync(PATHS.env)) {
    for (const line of fs.readFileSync(PATHS.env, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  // process env wins (lets you override for one run)
  for (const k of ['LINEAR_API_KEY', 'LINEAR_AGENT_UI_PORT', 'CURSOR_API_KEY']) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

export function saveEnv(patch: Record<string, string>): void {
  ensureHome();
  const current = fs.existsSync(PATHS.env) ? fs.readFileSync(PATHS.env, 'utf8') : '';
  const lines = current.split('\n').filter((l) => l.trim() !== '');
  for (const [k, v] of Object.entries(patch)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    const entry = `${k}=${v}`;
    if (idx >= 0) lines[idx] = entry;
    else lines.push(entry);
  }
  fs.writeFileSync(PATHS.env, lines.join('\n') + '\n', { mode: 0o600 });
}

export function getLinearApiKey(): string | undefined {
  return loadEnv().LINEAR_API_KEY || undefined;
}

// ---------- per-project config ----------

export interface ProjectFileConfig {
  linear: { teamKey: string; label: string; reviewState: string; assigneeOnly: boolean };
  git: { baseBranch: string; branchPrefix: string; remote: string };
  commands: { install: string; test: string; dev: string; devUrl: string; devReadyPath: string };
  worker: { kind: 'cursor' | 'claude'; model: string; timeoutMin: number };
  /** maxBudgetUsd is only meaningful with API-key billing; leave unset/0 on a Claude subscription (nothing is billed per token). */
  planner: { model: string; timeoutMin: number; maxBudgetUsd?: number };
  verifier: { model: string; maxRetries: number; timeoutMin: number; maxBudgetUsd?: number };
  supabase: { applyToDev: boolean };
  approvalGate: boolean;
  concurrency: number;
  pollSeconds: number;
  screenshots: boolean;
  testTimeoutMin: number;
  devBootTimeoutSec: number;
}

export const DEFAULT_PROJECT_CONFIG: ProjectFileConfig = {
  linear: { teamKey: '', label: 'agent', reviewState: 'In Review', assigneeOnly: false },
  git: { baseBranch: 'main', branchPrefix: 'agent/', remote: 'origin' },
  commands: { install: 'npm install', test: 'npm test', dev: 'npm run dev', devUrl: 'http://localhost:{port}', devReadyPath: '/' },
  worker: { kind: 'cursor', model: 'sonnet-4.5', timeoutMin: 20 },
  planner: { model: 'sonnet', timeoutMin: 6 },
  verifier: { model: 'sonnet', maxRetries: 2, timeoutMin: 6 },
  supabase: { applyToDev: true },
  approvalGate: true,
  concurrency: 1,
  pollSeconds: 25,
  screenshots: true,
  testTimeoutMin: 10,
  devBootTimeoutSec: 120,
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function mergeConfig(partial: DeepPartial<ProjectFileConfig> | null | undefined): ProjectFileConfig {
  const base = structuredClone(DEFAULT_PROJECT_CONFIG) as ProjectFileConfig;
  if (!partial) return base;
  const out: any = base;
  for (const [k, v] of Object.entries(partial)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = { ...out[k], ...v };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as ProjectFileConfig;
}

export function readProjectConfig(projectPath: string): ProjectFileConfig | null {
  const file = path.join(projectPath, PROJECT_CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  return mergeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function writeProjectConfig(projectPath: string, cfg: DeepPartial<ProjectFileConfig>): ProjectFileConfig {
  const merged = mergeConfig(cfg);
  fs.writeFileSync(path.join(projectPath, PROJECT_CONFIG_FILE), JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

export function validateConfig(cfg: ProjectFileConfig): string[] {
  const errs: string[] = [];
  if (!cfg.linear.teamKey) errs.push('linear.teamKey is required');
  if (!cfg.linear.label) errs.push('linear.label is required');
  if (!cfg.git.baseBranch) errs.push('git.baseBranch is required');
  if (!cfg.git.branchPrefix || cfg.git.branchPrefix === '/') errs.push('git.branchPrefix must be non-empty');
  if (!cfg.commands.test) errs.push('commands.test is required');
  if (cfg.concurrency < 1 || cfg.concurrency > 4) errs.push('concurrency must be 1..4');
  if (cfg.pollSeconds < 5) errs.push('pollSeconds must be >= 5');
  if (!['cursor', 'claude'].includes(cfg.worker.kind)) errs.push('worker.kind must be cursor|claude');
  return errs;
}
