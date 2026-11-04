# Road to 1.0

Version 0.3 adds durable bounded work sessions and recoverable maintenance. It is a meaningful
engine upgrade, not a claim that every real deployment and external service has been validated.
The public edition remains a single-owner, single-worker engine.

## Delivered in 0.3

- Fixed owner goals, typed checkpoints, explicit active-time budgets and per-thread ordering.
- Fair scheduling between verified steps without concurrently sharing a browser or Git index.
- Durable transcript and memory maintenance that cannot replay completed model work.
- Transactional upgrade from the 0.2 state format and verified private state snapshots.
- Offline regression coverage for execution, recovery, migration, maintenance and protocol failures.

## Required before 1.0

| Gate                       | Evidence required                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real deployment acceptance | A dedicated synthetic Discord deployment verifies owner rejection, exact session continuation, restart recovery, work pause and cancellation on the published image              |
| Crash and restore drill    | Documented process-kill tests around checkpoint commit and final delivery, plus a complete restore of state, workspace and Codex session storage                                 |
| Compatibility contract     | Supported Node/Codex versions, state schema policy, migration/rollback matrix and command behavior are documented and tested across supported releases                           |
| Multi-day operation        | A recorded unattended soak with mixed threads, authentication outage, unavailable Discord and Git/index failures; no lost accepted work or automatic replay of uncertain actions |
| Resource limits            | Measured queue/database growth, maintenance backlog behavior and checkpoint retention with an explicit supported operating envelope                                              |
| Independent release review | Privacy, state transitions, container confinement and published image identity reviewed against the exact release commit                                                         |

Offline tests support these gates but do not replace live Discord acceptance or a multi-day soak.
Completing these gates is more valuable than adding integrations before the execution contract is stable.

## Later candidates

History catch-up after an outage, isolated parallel workspaces, opt-in scheduling and publication
receipts may be useful additions. Each needs explicit authority rules, durable state and a
failure model. They are not included in the current release or promised by this roadmap.
