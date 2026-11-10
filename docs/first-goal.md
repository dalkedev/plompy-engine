# Your first supervised code goal

Use this walkthrough after the engine is running and a harmless Discord task has
succeeded. It takes the supplied synthetic project or your existing project through a bounded
code change and a separate review. Use private artifacts, not the public source checkout.

## Before you start

- Run version 0.11.1 with Node 26.13.0 or newer 26.x LTS and the protocol-tested Codex CLI 0.166.0, signed in
  as the service user using the engine's private `CODEX_HOME`. See the
  [quick start](../README.md#quick-start) and [runner setup](runners.md).
- Use the configured owner's thread in the private forum. It must be Codex-bound;
  changing the default runner does not change an existing thread's binding.
- Put the actual Git project inside the configured private workspace or artifacts
  directory, separate from authentication, browser and engine state. Use its Git
  root, not a parent folder or a source subdirectory.
- Know the project's test command and the behavior you want. Install its dependencies
  and give the service account the required access before starting.

The custom-project example further below assumes an existing project at `/srv/szpont/artifacts/quantity-parser`,
with `/srv/szpont/artifacts` configured as `SZPONT_ARTIFACTS_DIR`. It already has a
quantity parser, regression tests and a working `npm test` command. Substitute your
own project, task and test command throughout. An isolated working copy makes the
saved patch easier to interpret when other work is happening.

## Use the supplied acceptance project

From the public checkout, with your trusted private engine configuration loaded:

```sh
npm run acceptance -- init --destination "$SZPONT_ARTIFACTS_DIR/first-code-goal"
```

The destination must be new; its parent must already exist. This creates a Git
repository in `first-code-goal/repository` and an operator manifest alongside it,
outside the bound repository. Follow the printed `!goal 30m --repo ...` request
in your private Codex thread. The parser deliberately lacks negative-quantity
validation, so the initial repository tests and independent checker are expected
to fail. That controlled failure is part of the fixture, not an installation error.

After the worker and fresh reviewer complete the change:

```sh
npm run acceptance -- verify --manifest "$SZPONT_ARTIFACTS_DIR/first-code-goal/acceptance-manifest.json"
```

The checker verifies 25 actual behavior cases and unchanged fixture evidence,
independently of the repository's `npm test` script. Weakening or deleting tests
cannot establish success. Keep the manifest operator-owned; this is an acceptance
fixture, not an OS sandbox or proof against a malicious process with the same UID.
See the [fixture walkthrough](../examples/acceptance/README.md) for container commands,
precise parser rules and limits. Real Discord delivery, session continuation,
supervisor decisions and failure recovery remain separate observed gates.

## Choose the right command

| Request            | Use it when                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| Normal message     | One CLI turn is enough. A follow-up resumes the saved thread session.  |
| `!work 30m <goal>` | You want several checkpointed steps under one active-execution budget. |
| `!goal 30m <goal>` | You want a fresh Codex supervisor to review each worker candidate.     |
| `!loop 30m <goal>` | The same supervised behavior; `!loop` is an alias for `!goal`.         |

For code goals, add `--repo` to bind the actual project for automatic before/after
code evidence. An unbound goal still runs, but its automatic code evidence is
unavailable. The engine does not discover a project from your goal text.

## Start one concrete change

Send this in the authorized Discord thread after adapting the example:

```text
!goal 30m --repo "/srv/szpont/artifacts/quantity-parser" Reject negative quantities while preserving zero and positive values. Add regression coverage and run npm test. Report changed files and the observed test result. Keep the work local; do not push, publish or deploy.
```

Use JSON double quotes around paths with spaces, for example
`--repo "/srv/szpont/artifacts/My App"`. The path is on the engine host, not on your
phone. Flags go after the optional duration and before the goal text.

The queue receipt supplies a task ID and confirms the repository binding. It means
accepted, not running or completed. Save that ID for explicit commands. Check:

```text
!goal status
!queue
```

The engine saves a baseline, runs the worker, then seals the observed before/after
patch with its candidate. A fresh supervisor assesses that candidate against your
fixed goal and decides to continue, complete or block. Worker and supervisor share
the same budget: 1–120 whole minutes of active execution and at most 32 reviewed
steps. Omitting the duration gives 30 minutes. Queue waits do not consume that
budget; it is not a wall-clock deadline or a token/cost allowance.

## Read the result and evidence

Use `!goal status` and `!result` to inspect the latest task, or `!result <task ID>`
to select the saved result explicitly. Check the reported production change, the
regression tests and the actual validation output before accepting the result.
A supervisor verdict is a model assessment, not proof that tests passed.

The sealed patch compares contents immediately before and after that worker phase,
including committed, staged and nonignored new files. It is independent of Git
HEAD. Preexisting dirty contents are the baseline; edits by another process may
also appear. Changes outside the bound repository are not covered.

The reviewer receives hashes, changed paths, a bounded patch excerpt and a private
JSON evidence-file path. Read its completeness and omission metadata when assessing
coverage. **Partial or unavailable evidence never means an empty or clean diff.**
Binary content, sensitive paths and capture limits can leave gaps. The
[code diff guide](goal-code-diffs.md) explains the exact capture boundary.

## Pause, resume or stop

```text
!goal pause
!goal status
!goal resume
!goal stop
```

Controls select the latest supervised goal in this thread; append its task ID to
select it explicitly. Pause and stop wait for the current bounded subprocess to
succeed. A saved worker candidate is reviewed before another worker step after
resume. Resume requires a safely paused goal, remaining budget and an otherwise
idle, unblocked thread. A terminal review result takes precedence over a pending
pause or stop.

`!goal stop` preserves history and does not undo changes. For immediate process
interruption, use `!cancel <task ID>`, then reconcile any partial effects. Neither
control is a rollback command.

## Recover deliberately

If the goal blocks or a phase fails, first inspect `!status`, `!goal status`,
`!result <task ID>`, the saved evidence and any actual external effects. A timeout
alone does not tell you whether an action happened. Nothing is retried automatically.

With remaining budget, answer the blocker in the same thread:

```text
!recover The expected behavior is to reject negative values and accept zero. Inspect the saved candidate and tests before continuing.
```

`!recover [task ID] [instruction]` retains supervision and the original goal. A
saved candidate survives reviewer failure, so recovery can review it without
repeating the worker. If the worker itself was interrupted, recovery must reconcile
that uncertain attempt first. A recovery note cannot change the repository binding.

An exhausted budget cannot be resumed or renewed by `!recover`. To authorize more
work in the blocked thread, send a fresh explicit budget with the **same goal text**:

```text
!goal 30m Reject negative quantities while preserving zero and positive values. Add regression coverage and run npm test. Report changed files and the observed test result. Keep the work local; do not push, publish or deploy.
```

In that blocked-thread recovery, omitting `--repo` retains the existing binding.
An identical fixed goal and binding can carry the saved candidate and sealed
evidence forward for review. Changing either discards the pending candidate while
retaining history and previously charged time. Use a fresh `!goal` command with
`--repo` to change repositories, or `--no-repo` to detach code capture. Choosing a
fresh `!work` budget instead deliberately starts unsupervised work.

A host restart conservatively consumes the unknown remaining allowance of an
interrupted running goal. Inspect its state and authorize a fresh budget to continue;
a restart does not replay it. See [supervised goals](supervised-goals.md) for the
full persistence and recovery rules.

## Command reference

All commands below are owner-only and scoped to the current authorized thread.
Use real task IDs from the bot's receipts in place of `<task ID>`.

| Command                            | Purpose                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `!help`                            | Show the installed command help.                                                                           |
| `!status`                          | Read thread execution, runner, queue and maintenance state.                                                |
| `!queue`                           | Read accepted task IDs and waiting reasons without starting a model.                                       |
| `!result [task ID]`                | Read a saved result; defaults to the latest task.                                                          |
| `!goal status [task ID]`           | Read supervised goal state, budget and repository binding.                                                 |
| `!goal <control> [task ID]`        | Use `pause`, `resume` or `stop`, following the rules above.                                                |
| `!cancel <task ID>`                | Cancel queued work or interrupt this thread's active process.                                              |
| `!recover [task ID] [instruction]` | Reconcile and continue a blocking failed/interrupted task.                                                 |
| `!new-session`                     | Clear the CLI session, cancel queued tasks and paused supervised goals; retain runner binding and history. |

## If something stops

| Symptom                                        | What to check                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Goal command rejected; nothing queued          | Use a Codex thread, valid whole-minute budget and an absolute Git root inside workspace/artifacts. Check path separation and quoting. |
| `goal_diff_baseline_unavailable`               | The worker did not start. Check the bound root, service-user access and private state storage before explicit recovery.               |
| Candidate has unavailable post-worker evidence | Inspect the saved candidate and missing coverage. Do not repeat its worker solely to regenerate a patch.                              |
| `invalid_goal_review` or a supervisor failure  | Inspect the saved candidate; recover explicitly with remaining budget. The worker is not automatically repeated.                      |
| Resume rejected                                | Check for an exhausted budget, another queued/running task, a terminal goal or unresolved thread uncertainty.                         |
| Task remains queued                            | Read `!queue` for its blocker or runner-readiness state. One worker serves all threads; there is no start-time estimate.              |

Local regression tests use synthetic CLIs and local Git fixtures. They verify engine
behavior, not your model account, live review quality, Discord delivery or deployment.
Verify those boundaries on your own installation with harmless tasks.
