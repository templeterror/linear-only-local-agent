# linear-only-local-agent

**Linear is the only interface for shipping code — on your own machine, on your existing subscriptions.**

Label a ticket in Linear. A daemon on your laptop plans it with **Claude Code**, builds it with **Cursor** in an isolated git worktree of your real checkout, runs *your* tests and *your* dev server, has a separate Claude Code verifier grade the diff against pre-written acceptance criteria, and posts a preview (screenshot, test results, migration SQL) back on the ticket. Reply `approve` and it opens the PR on **GitHub**. Nothing is merged or deployed automatically.

No cloud VMs, no environment replication, no per-ticket credits: it runs in the environment you already have, with the MCP config (e.g. **Supabase** dev project) you already use.

```
 Linear ticket ──label──▶ daemon ──▶ Claude Code (plan + acceptance criteria)
                                        │  clarifying question? → posted on ticket, waits for your reply
                                        ▼
                                   git worktree  ──▶ Cursor CLI (build, dev-DB migration via Supabase MCP)
                                        │
                                        ▼
                                   tests · dev server · screenshot
                                        │
                                        ▼
                                   Claude Code (verify vs. criteria) ──fail──▶ fix instructions → Cursor (≤2 retries)
                                        │ pass
                                        ▼
                     preview + tests + migration SQL posted on ticket → reply "approve" → gh pr create → In Review
```

## Requirements

- macOS/Linux, Node ≥ 22.13 (uses the built-in `node:sqlite`; zero runtime dependencies)
- [Claude Code](https://claude.com/claude-code) CLI, logged in (`claude`)
- [Cursor CLI](https://cursor.com/cli), logged in (`cursor-agent login`)
- GitHub CLI, logged in (`gh auth login`)
- A Linear personal API key (Settings → API)
- Optional: a Chromium-based browser (Chrome/Edge/Brave/Arc) for screenshot previews; Supabase MCP configured in Cursor for dev-DB migrations

## Setup (5 minutes)

```sh
git clone https://github.com/templeterror/linear-only-local-agent
cd linear-only-local-agent && npm install
./bin/linear-agent start          # daemon + setup UI at http://localhost:4747
```

Then in the UI:

1. Paste your Linear API key (stored in `~/.linear-agent/.env`, mode 0600).
2. **Add a project** by absolute path. Test/dev/install commands and the base branch are detected from `package.json` and git; adjust if needed.
3. Pick the Linear **team**, the trigger **label** (default `agent`; created for you), and the **state** the issue moves to when the PR opens.
4. **Run doctor** — every row should be green (warnings are fine).
5. **Enable** the project.

Or from the CLI: `linear-agent add <path>` → edit `<path>/.linear-agent.json` → `linear-agent doctor <path>` → `linear-agent enable <path>`.

6. If your app needs a login to show anything useful, click **Log in for previews** once: a browser opens on your dev server, you sign in, the session (cookies + localStorage) is saved under `~/.linear-agent/preview-auth/` and replayed for every screenshot.

Now add the `agent` label to a ticket and watch the **Jobs** tab (or `linear-agent status`).

## Per-project config (`.linear-agent.json`)

```jsonc
{
  "linear":   { "teamKey": "ENG", "label": "agent", "reviewState": "In Review", "assigneeOnly": false },
  "git":      { "baseBranch": "main", "branchPrefix": "agent/", "remote": "origin" },
  "commands": { "install": "npm ci", "test": "npm test", "dev": "npm run dev",
                "devUrl": "http://localhost:{port}", "devReadyPath": "/" },   // PORT env + {port} are set per job
  "worker":   { "kind": "cursor", "model": "sonnet-4.5", "timeoutMin": 20 }, // or "claude" (drop-in)
  "planner":  { "model": "sonnet", "timeoutMin": 6 },                        // Claude Code, on your subscription
  "verifier": { "model": "sonnet", "maxRetries": 2, "timeoutMin": 6 },
  "supabase": { "applyToDev": true },      // worker applies migrations to the DEV project via Cursor's Supabase MCP
  "approvalGate": true,                    // false = open the PR as soon as the verifier passes
  "concurrency": 1, "pollSeconds": 25, "screenshots": true,
  "testTimeoutMin": 10, "devBootTimeoutSec": 120
}
```

## What happens on the ticket

| State | You see on the ticket |
|---|---|
| `triaging` | 🤖 picked up |
| `waiting_on_human` | 🤖 **question** — reply in a comment; the planner resumes its session with full repo context |
| `declined` | 🤖 **declined** with the reason (auth, payments, destructive SQL, CI/secrets, out of scope) |
| `planning` | 🤖 **plan**: branch, steps, acceptance criteria |
| `building` → `testing` → `verifying` | (worker runs; verifier may post *retry n/2* with fix instructions) |
| `awaiting_approval` | 🤖 **ready for review**: screenshot, criteria ✅/⚠️, diff stat, migration SQL, test output. Reply `approve` → PR. Anything else → sent back to the worker as change requests. |
| `pr_open` | 🤖 **PR opened** + link attached, issue moved to your review state |
| `failed` / `declined` | 🤖 **failed** / **declined** with details. Reply **`-tryagain-`** or **`-startover-`** (after editing the ticket if needed). |

Two commands work in any state where the daemon is listening (question, review, failed, declined):

- **`-tryagain-`** — same worktree and branch, redo from the build step (re-triage if there is no plan yet).
- **`-startover-`** — delete the worktree and local branch, fresh triage and plan.

Remove the label at any time to cancel.

## Guardrails

1. **Planner & verifier are read-only**: `claude -p` with an explicit `--allowedTools` whitelist (Read/Grep/Glob/`git diff|log|status`), `--disallowedTools Edit,Write,…`, `--max-turns` and a timeout. (No dollar caps: it runs on your Claude subscription; Claude Code's "cost" numbers are API-equivalent estimates, not charges.)
2. **Worker is jailed to its worktree** (`cursor-agent --workspace`), told never to commit/push/checkout, and its diff is scanned afterwards: edits to `.env*`, CI workflows, `.linear-agent.json`, destructive SQL (`DROP`, `TRUNCATE`, `DELETE` without `WHERE`, `DROP COLUMN`), or credential-looking strings fail the job before anything is pushed.
3. **Git**: branches are always `agent/*`; pushes use an explicit refspec, assert head ≠ base, never `--force`. The daemon never merges.
4. **Triage declines** auth, payments, destructive data ops, prod infra, secrets, and anything it cannot see.
5. **DB**: the daemon holds no database credentials. Migrations touch only the dev project the Supabase MCP is authorized for.
6. **Bounded**: per-step timeouts, max 2 verifier retries, concurrency cap, and every failure ends as a comment on the ticket.
7. **Idempotent & restart-safe**: one SQLite row per issue, validated state transitions with an audit log, comment IDs recorded so nothing is posted or run twice. Kill the daemon mid-build and restart — the job resumes from its current state in the same worktree.

## CLI

```
linear-agent start            daemon + setup UI
linear-agent once             one poll cycle, run launched steps to completion, exit
linear-agent status           list jobs
linear-agent doctor [path]    setup checks
linear-agent add|enable|disable <path>
linear-agent eval <path>      create the eval tickets in Linear, run them, write eval/RESULTS.md
linear-agent clean            remove worktrees of finished jobs
```

State lives in `~/.linear-agent/` (`state.db`, `projects.json`, `.env`, `worktrees/`, `artifacts/`, `logs/daemon.log`).

## Layout

```
src/daemon.ts      poll → ingest → route comments → dispatch steps (concurrency cap, in-flight set)
src/steps.ts       one handler per state; idempotent; every transition audited
src/state.ts       state machine (queued → triaging → [waiting_on_human] → planning → building → testing → verifying → awaiting_approval → pr_open | failed | declined)
src/planner.ts     claude -p triage + spec (structured output, resumable session)
src/verifier.ts    claude -p verdict + fix instructions
src/executors/     Executor interface: cursor.ts (default), claude.ts (drop-in)
src/runner.ts      tests, dev server on a free port, headless screenshot
src/guards.ts      diff scanner
src/linear.ts      GraphQL client (issues, comments, states, labels, file upload)
src/git.ts         worktrees, guarded push
src/ui/            setup UI (node:http + one HTML file)
eval/              11-ticket eval set + harness
```

## Eval

`eval/tickets.json` holds 11 tickets: 3 clear, 3 ambiguous (must ask), 2 needing DB migrations, 2 out of scope (must decline), 1 adversarial destructive-SQL ticket (must refuse). `linear-agent eval <project>` creates them in Linear, drives the daemon, and writes `eval/RESULTS.md` with expected vs. actual and an honest list of misses.
