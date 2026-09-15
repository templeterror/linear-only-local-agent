# Demo script (2:00, single take, screen on Linear throughout)

Pre-flight (off camera): `./bin/linear-agent start` running with the sample app enabled; `linear-agent doctor` green; a fresh ticket drafted; one ticket already parked in `waiting_on_human` (for the pause/resume beat); `eval/RESULTS.md` open in a second tab.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | Terminal + Cursor + browser tabs, cursor jumping between them | "Today shipping a ticket means: open Linear, paste it into Claude Code to plan, paste the plan into Cursor, check localhost, open a PR. Five tools, one ticket. Let's make Linear the only one." |
| 0:15–0:30 | Linear: add label `agent` to "Show the note count in the header". Comment appears: 🤖 picked up. | "One label. A daemon on my laptop — not a cloud VM — picks it up. It runs on the Claude and Cursor subscriptions I already pay for, in my real checkout, with my real dev DB." |
| 0:30–0:50 | 🤖 plan comment: branch, steps, acceptance criteria, worker. Cut to Jobs tab in the setup UI flipping `planning → building → testing`. | "Claude Code plans it read-only and writes acceptance criteria up front. Cursor builds it in an isolated git worktree. Then my own test suite and dev server run." |
| 0:50–1:10 | 🤖 ready for review: screenshot of localhost, ✅ criteria, diff stat, test output. | "A *separate* verifier grades the diff against those criteria — the worker never grades itself. The preview lands on the ticket: screenshot, tests, and if there were a migration, the SQL for me to run on prod." |
| 1:10–1:30 | Type `approve`. 🤖 PR opened; GitHub PR tab; Linear issue moves to In Review. | "I reply *approve*. It pushes an `agent/*` branch — never main — opens the PR, links it, moves the ticket. Merging stays human." |
| 1:30–1:50 | Pick one: (a) the parked ambiguous ticket: show 🤖 question, reply, watch it resume into a plan; or (b) terminal: `kill -9` the daemon during `building`, restart, Jobs tab shows the same job continuing from `building`, no duplicate comments. | (a) "When a ticket is ambiguous it asks instead of guessing, and resumes the same planning session with my answer." (b) "State is a SQLite row per ticket. Kill it mid-build, restart, it carries on. Nothing posts twice." |
| 1:50–2:00 | `eval/RESULTS.md` table. | "Eleven eval tickets: clear, ambiguous, DB migrations, out-of-scope, and one that tries to `DROP TABLE`. Here's the honest scorecard. Linear in, PR out, $0 marginal, your machine." |

Fallbacks: if Cursor auth is flaky, set `worker.kind: "claude"` (same interface) or add the `worker:claude` label to the demo ticket. If the screenshot upload fails the preview is text-only and the beat still works.
