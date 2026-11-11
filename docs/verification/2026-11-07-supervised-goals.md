# Supervised goal validation

Date: 2026-11-07. Runtime source: PR #7, including phase-accounting and
supervised-budget recovery regressions.
This record separates deterministic checks, real model coordination and live CLI
integration. These synthetic experiments do not establish real Discord delivery
or account-side actions.

## Deterministic regression and hosted checks

The updated source passed 460 offline tests: 351 engine tests and 109 script tests, plus
TypeScript build, formatting, whitespace and public-tree checks. Tests use real
SQLite state and fake CLI processes. Hosted workflow
[42413171448](https://github.com/dalkedev/plompy-engine/actions/runs/42413171448)
at recovery-fix head `e3f925f` passed all five jobs: Engine/Node 24, Browser/Python 3.12, public repository
hygiene, and native amd64/arm64 container builds and offline smoke checks.

## Earlier CLI startup attempt

The existing configured Codex CLI reports version 0.166.0 and successful login
status. A synthetic Engine attempt through the unmodified CLI adapter exited
before any `thread.started` or model event. A read-only filesystem warning was
observed, but the receipt did not establish it as the cause. No task files or
supervisor review were produced.
The Engine saved a failed job and blocked its workflow, with no automatic replay.
A separate no-tools startup diagnostic confirmed the pre-session failure.

Authentication status alone therefore does not establish that this executor can
start an agent. No home/configuration relocation, authentication copy, model or
permission change, or sandbox bypass was used. Raw diagnostics, credentials and
private runtime state are excluded from this public repository. The first receipt therefore cannot establish CLI acceptance. Subsequent testing
uses an operator-owned private runtime with existing credentials kept in place.

## Actual CLI and Engine acceptance in an operator-owned lab

A later synthetic experiment used the existing configured Codex CLI 0.166.0 and
credentials, through the private deployment's unmodified CLI integration adapter
and supervised Engine port. Required MCP configuration was retained. An early
minimal harness omitted the deployment's per-job MCP context; supplying that
normal context resolved initialization without changing permissions or credentials.

The recorded run contains 12 successful actual CLI phases: six worker calls using
one real saved session and six distinct fresh supervisor sessions. Workers used
`workspace-write`; supervisors used `read-only`, all with approval policy `never`.
Native collaboration records independently confirm two assignments and two completed
subagents. The operator reran 11 module tests and 18 independent assertions.

The deliberately staged initial goal and its explicit recovery remained blocked:
the supervisor requested historical evidence the fixture did not make available.
Their receipts remain immutable; they are not relabelled as successful. A separate
explicit `!goal 2m` in the same synthetic conversation verified the existing artifacts
without that temporal requirement. It resumed the same worker, received a fresh
supervisor's `completed` verdict, and finished `succeeded/completed` in 73,643 of
120,000 allowed milliseconds. The new goal retained recovery lineage; recovery of
the earlier budget did not reset time already charged.

All 44 source, compiled, schema and package-metadata hashes matched the tested
private candidate before and after execution. Raw sessions, deployment paths,
identifiers and credentials remain outside this public repository. The test used
an in-memory Discord transport and fixture hooks for isolated workspace persistence;
it did not exercise live Discord delivery, real publication tools or the private
workspace merge system. The public container/CLI checks and this private adapter
experiment establish different boundaries; neither substitutes for the other.

## Earlier native-agent bridge experiment

A separate synthetic experiment connects the real Engine state machine to actual
native Codex agents through an injected test bridge. It uses no Discord network
transport. Adapter session IDs are synthetic; this does **not** test CLI session
persistence, the production CLI adapter, or its filesystem sandbox enforcement.
The controller transfers model checkpoints and supplies a small, sanitized
receipt of observed native collaboration status; it does not export raw session
history or private diagnostics.

The main worker created exactly two independent child agents, one implementing
`sumEven(numbers)` and one writing three `node:test` cases. Both children finished
before the worker's first checkpoint. The first supervisor inspected the files,
found test execution unverified and returned `continue` with a concrete request
to run tests. The Engine resumed the same native worker. That worker ran the
three tests and saved the observed 3-pass/0-fail result.

A second fresh supervisor accepted the code/test evidence but requested independent
delegation corroboration. The controller supplied a receipt based on the actual
child completion messages and status readback. The next worker step reconciled
that receipt without repeating delegation, tests or earlier changes.

A third fresh supervisor inspected the independent controller receipt and accepted
completion. Engine readback shows `succeeded` / workflow `completed`, three
reviewed steps and three saved reviews. The same native worker handled all three
worker turns; every review used a different fresh native supervisor. The planned
two-step fixture required one additional evidence-reconciliation step. A separate
parent check read both source files and ran the three tests: 3 passed, 0 failed.
This small scenario is evidence for exercised coordination, not a reliability
benchmark or proof of a strict two-step completion guarantee.

### Missing decision and explicit recovery

A second native-agent experiment asked for a greeting artifact but intentionally
omitted its required recipient. The worker asked which name to use; a fresh
supervisor independently confirmed the missing input and returned `blocked` with
the concrete question. Engine state was `interrupted` / workflow `blocked`.
Calling the worker tick again produced no additional agent calls.

The controlled synthetic owner then answered through `!recover`, supplying `Ada`.
The same native worker read that explicit recovery instruction and created exactly
`Hello, Ada!` followed by one newline. A new fresh supervisor read and verified all
12 bytes. Final Engine readback shows the recovery job `succeeded`, workflow
`completed`, two retained reviews and the same synthetic worker-session binding.
The native task identity was also reused. No real owner message was sent by this
experiment; the controlled local test transport supplied the fixture input.

## Deployment checks still belong to the operator

Validate the chosen private forum, workspace persistence, MCP permissions and
notification delivery on each installation. Pause/cancel have deterministic
regressions but were not additional live-model cases in the final CLI experiment.
Keep test input synthetic and use a local transport for model acceptance. Never
use public posts or real account messages as smoke tests. A release does not
upgrade an existing private service automatically.
