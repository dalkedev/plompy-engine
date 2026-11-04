# Changelog

## Unreleased

## 0.3.0 — 2026-11-04

### Durable work sessions

- Add explicit `!work 30m <goal>` and `!work 2h <goal>` sessions with a fixed owner goal, active execution budget and 32-step cap.
- Validate typed JSON checkpoints against a shipped schema; resume the exact session only after a successful, completed process turn.
- Requeue verified steps fairly between threads while retaining per-thread ordering and one global worker.
- Distinguish verified budget pauses from uncertain failures, and retain charged time across manual recovery chains.
- Conservatively consume a crashed running workflow's uncheckpointed allowance instead of silently refunding unknown execution time on restart.

### Reliable state and memory

- Retry transcript export and scoped local Git commits durably, independently of model execution and authentication.
- Keep committed intake and task results authoritative when progress messages or export operations fail.
- Add transactional versioned SQLite migration preserving existing jobs, results, controls and sessions.
- Add verified online state backup and no-overwrite restore tooling, with upgrade and rollback documentation.
- Show current-thread workflow checkpoints and maintenance health without exposing other threads.

### Release scope

- Include the work output schema and state snapshot CLI in the non-root container image.
- Keep uncertain external actions subject to manual reconciliation; no automatic replay, parallel browser workers or private-deployment upgrade is introduced.
- Publish explicit 1.0 readiness criteria instead of treating a version number as evidence of production stability.

## 0.2.0 — 2026-11-04

### Distribution and project experience

- Add a non-root Docker runtime with separate private state, workspace, and Codex authentication volumes.
- Publish versioned Linux amd64 and arm64 images to GitHub Container Registry after source checks and offline container smoke tests.
- Include image provenance, an SBOM, OCI source/revision labels, and an exact image digest in release workflow results.
- Give Szpont Engine its own logo, banner, documentation index, contributor guidance, and public repository templates.
- Run the locked engine and browser test suites and a tracked-private-state guard in active GitHub Actions checks.

### Correctness fixes

- Commit task completion and conversation blocking atomically, and roll back session reset if queued cancellation cannot complete.
- Reject overlapping recovery requests and stale recovery after a successful recovery chain.
- Recover full blocked queues atomically without discarding work when recovery fails.
- Preserve service-user access to browser installations under a restrictive administrator umask.
- Check workspace permissions portably in the offline engine suite.

### Diagnostics and controls

- Add `!help` and actionable `!status` output for blocked queues, worker activity, session presence, and uncertain response delivery.
- Reject unknown commands and invalid arguments before queue or session changes.
- Add an offline deployment doctor with sanitized text/JSON reports and an explicit opt-in login check.

### Release boundaries

- The Docker image packages the public engine and Codex CLI. The optional graphical Camoufox bridge is configured separately.
- Releases do not contain conversations, real owner memory, browser profiles, credentials, or a preauthenticated account.

## 0.1.0 — Initial public core

- Owner-configured Discord identities and a separate private workspace initializer.
- Single-worker SQLite queue, exact per-thread Codex sessions and explicit interruption recovery.
- Scoped local Markdown memory commits and an optional Camoufox stdio MCP bridge.
- Synthetic templates, offline tests, English documentation and MIT license.
