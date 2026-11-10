# Road to 1.0

Version 0.9 joins private setup, deployment diagnostics and a reproducible first
code-goal fixture. The public edition remains a single-owner, single-worker engine.
A local or container test is evidence for its measured boundary; it does not prove
live account access, real Discord delivery or multi-day reliability.

## Delivered through 0.9

- Durable intake, deduplication, bounded queues and provider-bound sessions.
- Explicit work budgets, checkpoint recovery and saved supervisor candidates.
- Owner-bound repository diffs independent of staging/committing inside a step.
- Verified state snapshots and transactional public schema migrations through 6.
- Guided private setup, opt-in Discord REST diagnostics and the first-goal fixture.
- Independent source/privacy review and native-architecture offline container checks.

## Required before 1.0

| Gate                       | Evidence required                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real deployment acceptance | A dedicated synthetic Discord deployment verifies owner rejection, exact session continuation, restart recovery, work pause and cancellation on the published image              |
| Crash and restore drill    | Documented process-kill tests around checkpoint commit and final delivery, plus a complete restore of state, workspace and each enabled runner's session storage                 |
| Compatibility contract     | Supported Node/runner versions, state schema policy, migration/rollback matrix and command behavior are documented and tested across supported releases                          |
| Multi-day operation        | A recorded unattended soak with mixed threads, authentication outage, unavailable Discord and Git/index failures; no lost accepted work or automatic replay of uncertain actions |
| Resource limits            | Measured queue/database growth, maintenance backlog behavior and checkpoint retention with an explicit supported operating envelope                                              |
| Independent release review | Privacy, state transitions, container confinement and published image identity reviewed against the exact release commit                                                         |

Offline tests support these gates but do not replace live Discord acceptance or a multi-day soak.
Completing these gates is more valuable than adding integrations before the execution contract is stable.

## Later candidates

History catch-up after an outage, isolated parallel workspaces, opt-in scheduling and publication
receipts may be useful additions. Each needs explicit authority rules, durable state and a
failure model. They are not included in the current release or promised by this roadmap.

Claude Code and OpenCode host adapters remain experimental until harmless live
resume/cancel/checkpoint and host-boundary acceptance is recorded. The shipped
Codex container has its own independent sandbox verification.
