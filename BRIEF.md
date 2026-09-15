# System & reliability brief — linear-only-local-agent

*Multi-App AI Agent Hackathon (Lemma × Comma Capital), Sep 13 2026.*

## What it is

A daemon on the developer's own machine that makes Linear the only interface for shipping code. Label a ticket → Claude Code plans it → Cursor builds it in a git worktree of the real checkout → the developer's own tests and dev server run → a separate Claude Code verifier grades the diff against pre-written acceptance criteria → preview, tests and migration SQL are posted on the ticket → on `approve`, a PR is opened on GitHub. Merging and prod migrations stay human.

**Apps connected (3):** Linear (trigger, Q&A, approval, status), GitHub (branch push, PR, link-back), Supabase (dev-DB migrations through the developer's existing Cursor MCP config). Claude Code and Cursor are local engines on existing subscriptions, not counted.

## Architecture

```
                 ┌──────────────────────────── daemon (TypeScript, Node 22, zero runtime deps) ────────────────────────────┐
  Linear ◀──────▶│ poll 25s ─▶ ingest (SQLite row per issue) ─▶ route human comments ─▶ dispatch step (concurrency cap)      │
  (GraphQL)      │                                                                                                          │
                 │  triaging ──▶ claude -p  (read-only tools, --json-schema)  → automatable | question | out_of_scope       │
                 │  planning ──▶ git worktree ~/.linear-agent/worktrees/<proj>/<ID>  branch agent/<id>-<slug>                │
                 │  building ──▶ cursor-agent -p --workspace <wt> --force --approve-mcps   (Supabase MCP → dev project)      │
                 │               └─ guards.scanDiff(): .env / CI / destructive SQL / secrets → fail                          │
                 │  testing  ──▶ <test cmd> · <dev cmd> on a free port · headless Chromium screenshot · upload to Linear     │
                 │  verifying ─▶ claude -p (read-only) → pass | fail + fixInstructions ──▶ building (≤ 2 retries)            │
                 │               pass → commit → push agent/* (guarded) → "ready for review" comment                        │
                 │  awaiting_approval ── "approve" ──▶ gh pr create → attach link → move to review state → pr_open           │
                 └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  GitHub ◀── gh CLI ──┘                         Setup UI: http://localhost:4747 (projects, doctor, jobs)
```

- **Executor interface** `run({worktree, prompt, model, resumeId}) → {diff, diffStat, files, summary, sessionId}`: Cursor is the default worker; Claude Code is a drop-in (`worker.kind: "claude"`).
- **Planner session is resumable**: a clarifying question stores the `claude` session id; the developer's reply is fed back with `--resume`, so the planner keeps the repo context it already explored.

## State machine

`queued → triaging → [waiting_on_human ⇄] → planning → building → testing → verifying → awaiting_approval → pr_open`, plus terminal `failed` and `declined`. Transitions are validated against an explicit table (`src/state.ts`), persisted in SQLite (`~/.linear-agent/state.db`, WAL) with an audit `events` table, and every transition that a human should know about becomes a Linear comment.

Restart safety: the only in-memory state is the set of in-flight jobs. On restart the daemon re-runs the current step of every active job; steps are idempotent (worktree reuse, cheap planner re-call, worker told it may find partial work). Comment IDs are recorded so replies are consumed exactly once and our own comments are never mistaken for human input.

## Guardrails

| # | Guardrail | Mechanism |
|---|---|---|
| 1 | Planner/verifier cannot edit | `claude -p --allowedTools Read,Grep,Glob,LS,Bash(git diff:*),… --disallowedTools Edit,Write,MultiEdit,NotebookEdit --max-turns` + timeout |
| 2 | Worker is jailed | `cursor-agent --workspace <worktree>`; prompt forbids commit/push/checkout, `.env`, CI, destructive SQL |
| 3 | Diff scanner after every worker run | `.env*`, `.github/workflows/`, `.linear-agent.json`, `DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE`, `DELETE … ;` without `WHERE`, `DROP COLUMN`, credential-shaped strings → job fails, nothing pushed |
| 4 | Never main | branches always `agent/*`; push via explicit refspec; asserts head ≠ base; no `--force`; PR only, never merge |
| 5 | Triage declines | auth, payments, destructive data ops, prod infra/CI/secrets, anything not visible in the repo |
| 6 | No DB creds in the daemon | migrations go through the developer's Supabase MCP, authorized for the dev project only; SQL is posted for humans to run on prod |
| 7 | Bounded | per-step timeouts (planner 6m, worker 20m, tests 10m, dev boot 2m, verifier 6m), `--max-turns` per LLM call, max 2 verifier retries, concurrency cap |
| 8 | Idempotent | one row per issue id, state checked before every action, comment ids recorded, label removal cancels |
| 9 | Kill-safe | child processes run in their own process groups and are killed on daemon shutdown |
| 10 | Subscription limits are pauses, not failures | a Claude/Cursor "you've hit your session limit · resets 5:20pm" reply is detected in any engine call; the job keeps its state and worktree, gets a `retryAfter` parsed from the reset time (15 min fallback), posts one *paused* comment per hour at most, and resumes automatically |
| 11 | Human retry commands | `-tryagain-` (same worktree, redo from build) and `-startover-` (delete worktree + local branch, fresh triage) work from any listening state — dashed so they can never be confused with a change request; re-adding a removed label also restarts a finished ticket |

## Native vs. this

| | Linear Agent / Cursor cloud integration | linear-only-local-agent |
|---|---|---|
| Runs in | vendor cloud VMs | developer's machine, worktree of the existing checkout |
| Cost per ticket | credits / API rates | $0 marginal on existing Claude and Cursor subscriptions (Claude Code's own estimate: ≈ $0.50 API-equivalent per ticket for planner+verifier — never billed) |
| Environment | must be defined and replicated | existing env, MCP config, dev DB, localhost |
| Models | one agent, one model | Claude Code plans/verifies; Cursor builds with any model; swappable worker |
| Verification | worker self-assesses | separate verifier grades diff + tests against pre-written criteria |
| Terminal state | PR opened | preview + tests + migration SQL on the ticket; PR only after approval |
| Guardrails | vendor defaults | own tool whitelist, diff scanner, dev-only DB, no push to main |
| Interface | Linear | Linear (identical by design) |

## Evaluation

`eval/tickets.json`: 11 tickets against the sample Next.js app — 3 clear, 3 ambiguous (must ask), 2 requiring DB migrations, 2 out of scope (must decline), 1 adversarial destructive-SQL ticket (must refuse). `linear-agent eval <project>` creates them in Linear, drives the daemon, and writes `eval/RESULTS.md`.

**Results:** see `eval/RESULTS.md` (generated). _[to be filled after the run]_

_Dollar figures below are Claude Code's API-equivalent estimates (`total_cost_usd`); on a subscription nothing is billed per token — they are reported only to show how small each step is._

**Integration test (`npm run test:integration`)** — real daemon, fake Linear (JSON-backed), local bare git origin, Claude Code worker, ticket "show the note count in the header":
- triage $0.13 (23 s) → worktree → worker $0.15 (17 s) → tests 1 s → `next dev` boot + screenshot (≈65 s) → verifier `pass` 5/5 $0.12 → push. Total ≈ 2.5 min, ≈ $0.40.
- **Crash test:** SIGKILL 12 s into `building`; SQLite still says `building`; restart resumes at `building`, worker re-runs on the same worktree, job finishes in `awaiting_approval`. Comments after restart: *picked up* ×1, *plan* ×1, *ready for review* ×1 — nothing duplicated. `agent/eng-42-…` exists on origin, `main` untouched.
- `approve` reply routed to PR creation (fails in the test only because the bare origin is not a GitHub host — the exact error lands on the ticket).

**Planner-only dry run of all 11 tickets** (parallel, $1.66, 46 s): 10/11 correct decisions — 3/3 automatable with 5–6 criteria each, 2/2 DB tickets flagged `needsMigration`, 2/2 out-of-scope declined, adversarial declined, 2/3 ambiguous asked a question with concrete options. The miss (`ambiguous-3`, "change the colour scheme") was not a judgment error: Claude Code returned `error_max_structured_output_retries`. Fix: the `claude -p` wrapper now retries once on schema-validation failures.

Component checks before the full run:
- Planner on `clear-1` → `automatable`, 6 acceptance criteria, $0.24, 23 s. On `adversarial-1` → `out_of_scope`, citing both the `DROP TABLE` and the "skip the usual review" pressure, $0.22.
- Runner on the sample app → tests pass in 1.5 s; `next dev` boots on a free port, screenshot captured, server torn down.
- Worker (Claude Code executor, `worker.kind: "claude"`) on `clear-2` (note count in header) → 2 files changed, guards clean, tests pass, verifier `pass` 3/3; 32 s + 20 s, $0.27 + $0.14. Same `Executor` interface the Cursor worker implements.
- Verifier on a correct `formatRelativeTime` implementation → `pass`, 6/6 criteria, $0.12. On a stub that returns `"soon"` with no tests → `fail`, 1/6, with file-level fix instructions. The verifier also caught a real pipeline bug during development: the worktree's `node_modules` symlink was being staged (a `node_modules/` gitignore line matches directories, not symlinks) — fixed with a per-worktree `info/exclude`.

## Found in the wild (first live tickets on Linear)

- **TUP-21** (sample app, Claude Code worker on `opus`): the verifier rejected attempt 1 — the worker had papered over a flaky RTL test with a `within(container)` workaround and a misleading comment — sent file-level fix instructions, attempt 2 passed 6/6. Total ≈ 10 min including the retry, dev-server boot and two screenshots.
- **TUP-22** (real product, monorepo `frontend/`): planner 168 s, worker changed 5 files, jest passed, screenshot uploaded — then the verifier call hit the Claude subscription's session limit. The first version failed the job; that is now guardrail 10 (pause + auto-resume), and the label re-add retry (guardrail 11) exists because the failure comment promised a retry path that did not yet work.

## Known limitations

- Comment attribution relies on a `🤖 **linear-agent**` header + recorded comment ids because a personal API key posts as the developer; a dedicated Linear bot user would remove that ambiguity.
- The worker's Supabase access is whatever the developer's MCP config allows; the daemon enforces dev-only by policy and SQL scanning, not by holding the credential.
- Screenshots are of the configured preview route only; multi-page flows aren't captured. Pages behind a login render via a dev session the developer captures once in the UI ("Log in for previews": cookies + localStorage replayed through the Chrome DevTools Protocol — no Playwright dependency). The first real-product ticket (TUP-22) surfaced this: the map page showed the login screen, and the developer's instinct to ask the agent to "comment out auth" was correctly refused by the worker.
- One machine, one developer: concurrency is capped by laptop resources (default 1).
