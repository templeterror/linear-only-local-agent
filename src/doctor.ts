// Setup checks shared by the UI and the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS, ensureHome, getLinearApiKey, validateConfig } from './config.ts';
import { loadProject, packageDirs } from './registry.ts';
import { Linear } from './linear.ts';
import { ghAuthed } from './github.ts';
import { run } from './proc.ts';
import { findBrowser, loadAuth } from './browser.ts';

export interface Check {
  name: string;
  ok: boolean;
  warn?: boolean;
  detail: string;
  fix?: string;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

export async function doctor(projectPath?: string): Promise<Check[]> {
  const checks: Check[] = [];
  ensureHome();

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'Node.js ≥ 22.13', ok: nodeMajor >= 22, detail: `v${process.versions.node}` });

  const claude = await run('claude', ['--version'], { timeoutMs: 20_000 });
  checks.push({ name: 'Claude Code CLI (planner/verifier)', ok: claude.code === 0, detail: claude.code === 0 ? claude.stdout.trim() : 'not found on PATH', fix: 'npm i -g @anthropic-ai/claude-code && claude login' });

  const cursor = await run('cursor-agent', ['status'], { timeoutMs: 30_000 });
  const cursorOut = stripAnsi(cursor.stdout + cursor.stderr);
  let cursorAuthed = cursor.code === 0 && /logged in/i.test(cursorOut) && !/not logged in|authentication required/i.test(cursorOut);
  let cursorDetail = cursor.code === 0 ? cursorOut.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'installed' : 'not found on PATH';
  if (cursorAuthed && /unable to fetch/i.test(cursorOut)) {
    // `status` can report a stale login; prove it with a real headless call.
    const probe = await run('cursor-agent', ['-p', '--output-format', 'text', 'Reply with the single word OK.'], { timeoutMs: 60_000, cwd: os.tmpdir() });
    const probeOut = stripAnsi(probe.stdout + probe.stderr);
    cursorAuthed = probe.code === 0 && !/authentication required|not logged in/i.test(probeOut);
    cursorDetail = cursorAuthed ? 'headless call OK' : probeOut.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'headless call failed';
  }
  checks.push({ name: 'Cursor CLI (worker)', ok: cursorAuthed, detail: cursorDetail, fix: 'cursor-agent login' });

  const gh = await ghAuthed();
  checks.push({ name: 'GitHub CLI (PRs)', ok: gh.ok, detail: gh.detail, fix: 'gh auth login' });

  const key = getLinearApiKey();
  let linear: Linear | null = null;
  if (!key) checks.push({ name: 'Linear API key', ok: false, detail: `missing (set in UI or ${PATHS.env})`, fix: 'Linear → Settings → API → Personal API keys' });
  else {
    try {
      linear = new Linear(key);
      const v = await linear.viewer();
      checks.push({ name: 'Linear API key', ok: true, detail: `authenticated as ${v.name}` });
    } catch (e: any) {
      checks.push({ name: 'Linear API key', ok: false, detail: e.message });
    }
  }

  const browser = findBrowser();
  checks.push({ name: 'Chromium browser (screenshots)', ok: !!browser, warn: !browser, detail: browser ?? 'none found — previews will be text-only', fix: 'install Chrome/Edge or set LINEAR_AGENT_BROWSER' });

  try {
    fs.accessSync(PATHS.worktrees, fs.constants.W_OK);
    checks.push({ name: 'Worktree dir writable', ok: true, detail: PATHS.worktrees });
  } catch {
    checks.push({ name: 'Worktree dir writable', ok: false, detail: PATHS.worktrees });
  }

  if (!projectPath) return checks;

  // ---- project-level ----
  const project = loadProject(projectPath);
  checks.push({ name: 'Project config file', ok: project.hasConfigFile, detail: project.hasConfigFile ? path.join(project.path, '.linear-agent.json') : 'missing — save the config from the UI', fix: 'save config' });
  const errs = validateConfig(project);
  checks.push({ name: 'Config valid', ok: errs.length === 0, detail: errs.length ? errs.join('; ') : 'ok' });

  const base = project.git.baseBranch;
  const remoteUrl = await run('git', ['-C', project.path, 'remote', 'get-url', project.git.remote], { timeoutMs: 10_000 });
  if (remoteUrl.code !== 0) {
    checks.push({ name: `Remote branch ${project.git.remote}/${base}`, ok: false, detail: `no git remote named "${project.git.remote}" — PRs need a GitHub remote`, fix: `gh repo create <owner>/<name> --private --source "${project.path}" --push` });
  } else {
    const lsRemote = await run('git', ['-C', project.path, 'ls-remote', '--heads', project.git.remote, base], { timeoutMs: 30_000 });
    const found = lsRemote.code === 0 && lsRemote.stdout.includes(`refs/heads/${base}`);
    checks.push({ name: `Remote branch ${project.git.remote}/${base}`, ok: found, detail: found ? `${remoteUrl.stdout.trim()}` : lsRemote.code === 0 ? `branch "${base}" not on ${remoteUrl.stdout.trim()} — push it or change git.baseBranch` : lsRemote.stderr.trim().split('\n')[0].slice(0, 160) });
  }

  checks.push({ name: 'Test command', ok: !!project.commands.test, detail: project.commands.test || 'missing' });
  checks.push({ name: 'Dev command', ok: !!project.commands.dev, warn: !project.commands.dev, detail: project.commands.dev || 'missing — previews disabled' });
  const auth = loadAuth(project.name);
  checks.push({ name: 'Preview login (for pages behind auth)', ok: !!auth, warn: !auth, detail: auth ? `captured ${auth.capturedAt.slice(0, 16).replace('T', ' ')} · ${auth.cookies.length} cookies, ${Object.keys(auth.localStorage).length} localStorage keys` : 'not captured — screenshots will show the logged-out state', fix: 'Projects → "Log in for previews"' });
  const linkable = packageDirs(project.path).filter((d) => fs.existsSync(path.join(project.path, d, 'node_modules')));
  checks.push({ name: 'node_modules present (linked into worktrees)', ok: linkable.length > 0, warn: true, detail: linkable.length ? linkable.map((d) => `${d}/node_modules`).join(', ') : `absent — each worktree will run "${project.commands.install || '(no install cmd)'}"` });

  if (linear && project.linear.teamKey) {
    try {
      const teams = await linear.teams();
      const team = teams.find((t) => t.key === project.linear.teamKey);
      checks.push({ name: `Linear team ${project.linear.teamKey}`, ok: !!team, detail: team ? team.name : `not found (have: ${teams.map((t) => t.key).join(', ')})` });
      if (team) {
        const labels = await linear.labels(team.key);
        const hasLabel = labels.some((l) => l.name.toLowerCase() === project.linear.label.toLowerCase());
        checks.push({ name: `Trigger label "${project.linear.label}"`, ok: hasLabel, detail: hasLabel ? 'exists' : 'missing — will be created when you enable the project', fix: 'create label' });
        const states = await linear.states(team.key);
        const st = states.find((s) => s.name.toLowerCase() === project.linear.reviewState.toLowerCase());
        checks.push({ name: `Review state "${project.linear.reviewState}"`, ok: !!st, detail: st ? `type=${st.type}` : `not found (have: ${states.map((s) => s.name).join(', ')})` });
      }
    } catch (e: any) {
      checks.push({ name: 'Linear team lookup', ok: false, detail: e.message });
    }
  }

  if (project.supabase.applyToDev) {
    const mcp = path.join(os.homedir(), '.cursor', 'mcp.json');
    let has = false;
    try {
      has = !!JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers?.supabase;
    } catch {
      /* none */
    }
    checks.push({ name: 'Supabase MCP in Cursor (dev migrations)', ok: has, warn: !has, detail: has ? `${mcp} → mcpServers.supabase` : 'not configured — migrations will be written but not applied', fix: 'add supabase to ~/.cursor/mcp.json (dev project only)' });
  }

  return checks;
}
