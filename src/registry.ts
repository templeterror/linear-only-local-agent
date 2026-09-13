// Registry of projects the daemon serves (~/.linear-agent/projects.json) +
// default detection for a freshly added project.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureHome, readProjectConfig, type ProjectFileConfig, mergeConfig } from './config.ts';
import { run } from './proc.ts';

export interface RegistryEntry {
  path: string;
  enabled: boolean;
  addedAt: string;
}

export interface Project extends ProjectFileConfig {
  path: string;
  name: string;
  enabled: boolean;
  hasConfigFile: boolean;
}

function readRegistry(): RegistryEntry[] {
  if (!fs.existsSync(PATHS.registry)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(PATHS.registry, 'utf8'));
    return Array.isArray(j.projects) ? j.projects : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[]): void {
  ensureHome();
  fs.writeFileSync(PATHS.registry, JSON.stringify({ projects: entries }, null, 2) + '\n');
}

export function listRegistry(): RegistryEntry[] {
  return readRegistry();
}

export function addProject(p: string): RegistryEntry {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`not a directory: ${abs}`);
  if (!fs.existsSync(path.join(abs, '.git'))) throw new Error(`not a git repository: ${abs}`);
  const entries = readRegistry();
  const existing = entries.find((e) => e.path === abs);
  if (existing) return existing;
  const entry: RegistryEntry = { path: abs, enabled: false, addedAt: new Date().toISOString() };
  entries.push(entry);
  writeRegistry(entries);
  return entry;
}

export function removeProject(p: string): void {
  const abs = path.resolve(p);
  writeRegistry(readRegistry().filter((e) => e.path !== abs));
}

export function setEnabled(p: string, enabled: boolean): void {
  const abs = path.resolve(p);
  const entries = readRegistry();
  const e = entries.find((x) => x.path === abs);
  if (!e) throw new Error(`project not registered: ${abs}`);
  e.enabled = enabled;
  writeRegistry(entries);
}

export function loadProject(p: string): Project {
  const abs = path.resolve(p);
  const entry = readRegistry().find((e) => e.path === abs);
  const file = readProjectConfig(abs);
  return {
    ...(file ?? mergeConfig(null)),
    path: abs,
    name: path.basename(abs),
    enabled: entry?.enabled ?? false,
    hasConfigFile: file !== null,
  };
}

export function loadAllProjects(): Project[] {
  return readRegistry().map((e) => loadProject(e.path));
}

export function loadEnabledProjects(): Project[] {
  return loadAllProjects().filter((p) => p.enabled && p.hasConfigFile);
}

// ---------- default detection ----------

export interface Detected {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  /** Directory (relative to the project) holding the package.json the commands run in; "." for single-package repos. */
  packageDir: string;
  scripts: Record<string, string>;
  framework: string | null;
  baseBranch: string;
  remote: string | null;
  hasSupabaseDir: boolean;
}

/** Package directories: the root if it has a package.json, plus first-level subdirectories that do (monorepos). */
export function packageDirs(root: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(root, 'package.json'))) out.push('.');
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    if (fs.existsSync(path.join(root, d.name, 'package.json'))) out.push(d.name);
  }
  return out;
}

const PREFERRED_APP_DIRS = ['frontend', 'web', 'app', 'client', 'site', 'ui'];

export async function detectDefaults(p: string): Promise<{ detected: Detected; config: Partial<ProjectFileConfig> }> {
  const abs = path.resolve(p);
  const dirs = packageDirs(abs);
  const packageDir = dirs.includes('.') ? '.' : (PREFERRED_APP_DIRS.find((d) => dirs.includes(d)) ?? dirs[0] ?? '.');
  const pkgRoot = path.join(abs, packageDir);
  const pkgPath = path.join(pkgRoot, 'package.json');
  let scripts: Record<string, string> = {};
  let deps: Record<string, string> = {};
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      scripts = pkg.scripts ?? {};
      deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    } catch {
      /* ignore */
    }
  }
  const has = (f: string) => fs.existsSync(path.join(pkgRoot, f));
  const packageManager: Detected['packageManager'] = has('bun.lock') || has('bun.lockb') ? 'bun' : has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('package.json') ? 'npm' : null;
  const framework = deps.next ? 'next' : deps.vite ? 'vite' : deps.express ? 'express' : deps.remix ? 'remix' : null;

  let baseBranch = 'main';
  let remote: string | null = null;
  const head = await run('git', ['-C', abs, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.stdout.trim()) baseBranch = head.stdout.trim().replace(/^origin\//, '');
  else {
    const branches = await run('git', ['-C', abs, 'branch', '--list', 'main', 'master']);
    const names = branches.stdout.split('\n').map((s) => s.replace('*', '').trim()).filter(Boolean);
    if (names.includes('main')) baseBranch = 'main';
    else if (names.includes('master')) baseBranch = 'master';
  }
  const rem = await run('git', ['-C', abs, 'remote', 'get-url', 'origin']);
  if (rem.code === 0) remote = rem.stdout.trim();

  const pm = packageManager ?? 'npm';
  const runScript = (s: string) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : pm === 'yarn' ? `yarn ${s}` : `${pm} run ${s}`);
  const installCmd = pm === 'npm' ? (has('package-lock.json') ? 'npm ci' : 'npm install') : pm === 'yarn' ? 'yarn install --frozen-lockfile' : `${pm} install`;

  // Monorepo: commands run from the app package directory.
  const inDir = (cmd: string) => (cmd && packageDir !== '.' ? `cd ${packageDir} && ${cmd}` : cmd);
  const config: Partial<ProjectFileConfig> = {
    git: { baseBranch, branchPrefix: 'agent/', remote: 'origin' },
    commands: {
      install: inDir(packageManager ? installCmd : ''),
      test: inDir(scripts.test ? runScript('test') : ''),
      dev: inDir(scripts.dev ? runScript('dev') : scripts.start ? runScript('start') : ''),
      devUrl: 'http://localhost:{port}',
      devReadyPath: '/',
    },
  };

  return {
    detected: { packageManager, packageDir, scripts, framework, baseBranch, remote, hasSupabaseDir: fs.existsSync(path.join(abs, 'supabase')) },
    config,
  };
}
