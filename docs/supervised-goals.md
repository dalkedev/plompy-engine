# Supervised goals

For a practical walkthrough, see [your first supervised code goal](first-goal.md).

Use a Codex-bound private Discord thread to ask the main worker to keep advancing
a fixed goal, with a separate agent reviewing each step:

```text
!goal 2h Fix the CSV importer, verify regressions and prepare a draft PR.
!loop 30m Implement the agreed CLI and report tested behavior.
!goal 30m --repo "/absolute/artifacts/app" Fix the parser and verify regressions.
```

`!loop` is an alias for `!goal`. Without a duration, the budget is 30 minutes.
Supported explicit budgets are 1–120 whole minutes (`1m`…`120m`, `1h`, `2h`).
The loop stops when the goal is complete or blocked; time is a ceiling. Both
worker and supervisor consume the same execution budget. At most 32 reviewed
steps run in one budget. This is not an unlimited token or spending allowance.
No per-step confirmation is needed within the original authorization.

Automatic code diffs require an explicit `--repo` binding. The repository must be
inside the configured workspace/artifacts and separate from authentication,
browser and engine state. Goals without a binding keep the existing behavior and
explicitly report that automatic code evidence is unavailable. See
[code diff evidence](goal-code-diffs.md) for scope, limits and recovery semantics.

The main worker can coordinate available subagents. Subagent availability depends
on the operator's Codex setup; the engine does not install or enable them, create
a fixed team size, change models, or run another background supervisor daemon.
Each supervisor is a fresh Codex session, separate from the worker's saved session.
Other runners remain supported for ordinary tasks and `!work`; supervised goals
currently reject Claude/OpenCode threads without changing their provider.

## Review and continuation

The worker returns a candidate containing observed changes, validation results and
external-action receipts. The engine saves it and charges execution time before
review. The supervisor reads the candidate and relevant artifacts and returns a
strict review: `outcome`, `summary`, `nextAction`, and boolean `progress`. It can
veto a worker completion, request a concrete next step, accept completion, or ask
a follow-up when blocked. Three consecutive reviews without progress block the
goal; an identical candidate also counts as no progress. Other eligible threads
get turns between worker/reviewer pairs, rather than between their subprocesses.

A review is a fallible model assessment, not proof that tests or external actions
succeeded. Check the saved evidence. The reviewer uses a read-only filesystem
sandbox and instructions prohibiting effects and delegation. Configured MCP tools
are **not** separately made read-only by this mode. The original owner scope and
integration permissions still govern every phase.

## Controls

```text
!goal status
!goal pause
!goal resume
!goal stop
```

Each accepts an optional task ID, and each also works with `!loop`. Without an ID,
the latest supervised goal in the current thread is selected. Controls are
owner-only, deduplicated by Discord message ID, and cannot reach another thread.
Status reads local state without a model call.

Pause and stop take effect after the current bounded subprocess succeeds. A
paused worker candidate remains saved; resume reviews it before any new worker
step. Resume requires remaining budget and no queued/running work or unresolved
uncertainty in this thread. Stop preserves history and does not undo effects.
If the current review completes or blocks the goal, that terminal result takes
precedence over a pending pause/stop. A blocked result keeps its reconciliation
target and thread block; no further work starts automatically.
For immediate interruption use `!cancel <task ID>`; partial effects then require
reconciliation. A timeout, malformed result, process failure or cancellation never
causes an automatic retry, even if only the reviewer failed.

A blocked review includes a follow-up question or reconciliation request. Answer
with `!recover [task ID] <your answer>` after inspecting status, saved results and
receipts. Recovery retains supervision and any saved candidate; it does not repeat
the worker just because review failed. If worker execution itself is uncertain,
manual recovery first reconciles the previous attempt.

An exhausted budget cannot be resumed. In a blocked thread, authorize a fresh
budget using `!goal 30m <goal>`. When the fixed goal and repository binding are identical, a saved candidate
and its sealed evidence can carry forward to review; changing either retains
history but starts a new candidate. A fresh ordinary `!work` deliberately starts an unsupervised budget.
A safely paused goal can instead be followed by a new explicit goal in the same
saved conversation. Session reset cancels paused goals as well as queued work.

Startup marks running jobs interrupted and conservatively consumes their unknown
remaining allowance. Candidates survive, but review after a host crash requires
a fresh explicit budget; nothing is replayed automatically. See
[work sessions](work-sessions.md) for shared queue and recovery behavior.

## Upgrade and validation

Version 0.8.0 migrates public SQLite schemas 0–5 to **schema 6**, retaining
private candidates/review history and adding explicit repository bindings and
sealed code evidence. Existing goals receive no implicit repository binding.
Take a coordinated pre-upgrade [state snapshot](state-backups.md) and retain the
matching workspace/binary. Version 0.7.0 and earlier reject schema 6. To roll back, restore the pre-upgrade snapshot into
a new private state location and reconcile later external actions; never lower
`user_version` or remove tables to bypass compatibility checks. Snapshot tools
in this source support schemas through 6 without migrating them.

Deterministic tests use synthetic workspaces and fake CLI processes. The code-diff
regressions also use real local Git repositories; they do not establish live model
review or deployment acceptance. Separate 0.7.0 experiments exercised native delegation through an injected bridge and through
the actual configured CLI in an operator-owned lab: the same worker resumed,
fresh supervisors reviewed each step, blocked evidence required explicit recovery,
and a new explicit goal reached completed. The
[validation record](verification/2026-11-07-supervised-goals.md) records the exact
boundaries, including fixture hooks and the private deployment adapter. Validate
Discord delivery, configured tools and workspace persistence on your installation;
a release does not update a private service automatically.
