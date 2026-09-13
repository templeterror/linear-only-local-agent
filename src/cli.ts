#!/usr/bin/env node
// linear-agent CLI: start | once | status | doctor | add | enable | disable | eval | clean
import fs from 'node:fs';
import path from 'node:path';
import { Db } from './db.ts';
import { Daemon } from './daemon.ts';
import { doctor } from './doctor.ts';
import { PATHS, ensureHome } from './config.ts';
import { addProject, setEnabled, loadAllProjects, loadProject, detectDefaults } from './registry.ts';
import { writeProjectConfig } from './config.ts';
import { startUi, uiPort } from './ui/server.ts';
import { removeWorktree } from './git.ts';
import { TERMINAL_STATES } from './state.ts';
import { log } from './log.ts';

const [, , cmd = 'help', ...rest] = process.argv;

const HELP = `linear-agent — Linear is the only interface for shipping code, on your own machine.

  linear-agent start            run the daemon + setup UI (http://localhost:${uiPort()})
  linear-agent once             one poll cycle, run every launched step to completion, exit
  linear-agent status           print all jobs
  linear-agent doctor [path]    setup checks (global, or for a project)
  linear-agent add <path>       register a project (writes .linear-agent.json with detected defaults)
  linear-agent enable <path>    enable a registered project
  linear-agent disable <path>
  linear-agent eval <path>      create the eval tickets in Linear and record results (see eval/)
  linear-agent clean            remove worktrees of finished jobs
`;

function printChecks(checks: Awaited<ReturnType<typeof doctor>>): boolean {
  let allOk = true;
  for (const c of checks) {
    const mark = c.ok ? '✔' : c.warn ? '⚠' : '✘';
    if (!c.ok && !c.warn) allOk = false;
    console.log(`${mark} ${c.name.padEnd(44)} ${c.detail}${!c.ok && c.fix ? `  → ${c.fix}` : ''}`);
  }
  return allOk;
}

async function main(): Promise<void> {
  ensureHome();
  switch (cmd) {
    case 'start': {
      const db = new Db();
      const daemon = new Daemon(db);
      startUi({ port: uiPort(), db, daemon });
      await daemon.run();
      return;
    }
    case 'once': {
      const db = new Db();
      const daemon = new Daemon(db);
      await daemon.once();
      const s = daemon.status();
      if (s.lastError) console.error('error:', s.lastError);
      return;
    }
    case 'status': {
      const db = new Db();
      const jobs = db.listJobs();
      if (!jobs.length) return console.log('no jobs');
      for (const j of jobs) {
        console.log(`${j.identifier.padEnd(10)} ${j.state.padEnd(18)} att=${j.attempt} ${path.basename(j.projectPath).padEnd(16)} ${j.prUrl ?? j.branch ?? ''}  ${j.title}`);
      }
      return;
    }
    case 'doctor': {
      const ok = printChecks(await doctor(rest[0] ? path.resolve(rest[0]) : undefined));
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'add': {
      if (!rest[0]) throw new Error('usage: linear-agent add <path>');
      const entry = addProject(rest[0]);
      const p = loadProject(entry.path);
      if (!p.hasConfigFile) {
        const det = await detectDefaults(entry.path);
        writeProjectConfig(entry.path, det.config);
        console.log(`wrote ${path.join(entry.path, '.linear-agent.json')} (detected: ${JSON.stringify(det.detected)})`);
      }
      console.log(`registered ${entry.path}. Set linear.teamKey in .linear-agent.json (or use the UI), then: linear-agent enable ${entry.path}`);
      return;
    }
    case 'enable':
    case 'disable': {
      if (!rest[0]) throw new Error(`usage: linear-agent ${cmd} <path>`);
      setEnabled(rest[0], cmd === 'enable');
      console.log(`${cmd}d ${path.resolve(rest[0])}`);
      return;
    }
    case 'eval': {
      const { runEval } = await import('../eval/run.ts');
      await runEval(rest[0] ? path.resolve(rest[0]) : undefined, rest.slice(1));
      return;
    }
    case 'clean': {
      const db = new Db();
      let n = 0;
      for (const j of db.listJobs({ states: TERMINAL_STATES })) {
        if (j.worktree && fs.existsSync(j.worktree)) {
          await removeWorktree(j.projectPath, j.worktree);
          n++;
        }
      }
      console.log(`removed ${n} worktrees`);
      return;
    }
    case 'projects': {
      for (const p of loadAllProjects()) console.log(`${p.enabled ? '●' : '○'} ${p.name.padEnd(20)} ${p.linear.teamKey || '-'}/${p.linear.label}  ${p.path}`);
      return;
    }
    default:
      console.log(HELP);
      console.log(`home: ${PATHS.home}`);
  }
}

main().catch((e) => {
  log('cli', `fatal: ${e.message}`);
  console.error(e.stack ?? e);
  process.exit(1);
});
