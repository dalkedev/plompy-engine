# Changelog

## 0.12.0 (2026-11-11): Plompy Engine

- Rebrand the project, repository links, packages, CLI, configuration examples and container to **plompy-engine**.
- Accept legacy `SZPONT_*` environment settings with explicit `PLOMPY_*` values taking precedence. Preserve existing state paths, managed MCP configurations, browser identity and cross-version locks.
- Provide a [migration guide](docs/migration-plompy.md) and external-volume Compose override for existing installations. No private data, Discord identities, login profiles or service processes are moved automatically.
- Introduce the Plompy identity, logo and repository artwork.

## 0.11.1 (2026-11-10)

- Add an explicit `--tool-approval approve` option for the built-in Codex Playwright integration, enabling unattended browser actions without changing global approval settings. Keep the default and `--yes` behavior unchanged; support an explicit `prompt` policy as well.
- Inspect the private raw TOML alongside Codex MCP status, preserving operator approval overrides, tool restrictions and unknown settings that the CLI status projection omits. Validate scoped policy with the installed CLI before atomically installing configuration.
- Document migration from an existing managed entry and the difference between configured tools and verified browser execution. Retain SQLite schema 6, provider bindings and browser sandboxing.

## 0.11.0 (2026-11-10)

- Add Playwright, Perplexity, Firecrawl, TinyFish and PostHog to the guided integrations menu for Codex, Claude Code and OpenCode, with maintained task instructions and explicit authentication modes.
- Provision an optional pinned Playwright MCP server with isolated headless Chromium, sandboxing, private per-launch output and no runtime browser installation. Exercise navigation, snapshot references, typing, clicking, screenshots and concurrent session isolation on a synthetic local page.
- Configure hosted MCP OAuth without initiating login during setup. Add an optional pinned stdio bridge for API keys held in separate private credential files; keep secrets out of managed configuration, arguments and the whole-agent environment. Bound requests, propagate cancellation, reject redirects and avoid replaying uncertain calls.
- Support Firecrawl's explicit keyless mode and request PostHog's server-side read-only mode. The PostHog integration does not install an analytics SDK or collect engine telemetry.
- Include the small API bridge in the Codex Docker image and test packaged configuration offline on both architectures. Browsers, model accounts and vendor access are provisioned separately.
- Retain Node 26 LTS, SQLite schema 6, provider bindings, saved sessions and explicit recovery semantics.

## 0.10.0 (2026-11-10)

- Require official Node 26 LTS, at least 26.13.0, and SQLite 3.54.0 or newer. Migrate the pinned container, CI, host instructions and developer version files together. Node 24 is no longer supported by this release.
- Verify the linked SQLite version from runtime metadata and a fresh in-memory SQL query before opening state. Reject unsupported or inconsistent runtimes during startup, setup, diagnostics and snapshots.
- Address CVE-2026-119375 by using the patched SQLite embedded in the supported Node runtime; preserve the historical finding for older releases. No npm SQLite-driver replacement, custom Node build or database migration is involved.
- Retain public SQLite schema 6, runner bindings, saved sessions and explicit recovery semantics. Take a coordinated private backup before changing the runtime or service release.

## 0.9.0 (2026-11-10)

- Add guided private setup for Codex and the experimental host adapters, hidden token input, explicit token-file/stdin automation and shell-quoted mode-0600 configuration. Preserve existing resources and failed/concurrent workspaces of uncertain ownership.
- Add opt-in read-only `doctor --check-discord` checks for bot identity, guild owner, private forum and effective reply permissions, with bounded requests and credential-safe diagnostics. Default doctor remains offline.
- Ship a self-contained first-goal Git fixture and independent 25-case checker. Distinguish its expected negative-quantity failure from setup failures, and reject weakened tests or altered evidence.
- Exercise setup, the actual pinned Codex version, offline doctor, independent fixture RED/GREEN and tamper controls inside both container architectures. Keep live Discord/model acceptance and soak evidence separate from offline checks.
- Refresh guild ownership and roles from Discord before authorization instead of trusting an incomplete or stale Gateway cache. Preserve owner/privacy rejection when the fresh read fails.
- Retain SQLite schema 6 and current recovery/provider semantics. The known Node 24 SQLite finding remains open; this release does not claim runtime remediation.

## 0.8.1 (2026-11-09)

- Keep the shared 30-job queue bound when resuming a safely paused supervised goal. A full queue leaves its saved candidate, control state and remaining budget unchanged; retry `!goal resume` after capacity is available.
- Point unsuccessful goal controls to `!queue` as well as `!goal status`. Existing per-thread limits, supervision, providers and SQLite schema 6 are unchanged.

## 0.8.0 (2026-11-09)

- Bind a code repository to a supervised goal with `--repo <absolute path>`. Capture its working-tree contents before and after each worker step, so commits and staging cannot hide code or test changes from the fresh supervisor.
- Persist the baseline before execution and seal the resulting patch with the worker candidate. Pause, restart and reviewer recovery retain the original evidence; later live edits cannot silently replace it.
- Give supervisors a bounded patch, changed-file inventory, explicit coverage limits, a private evidence file and the two most recent candidate/review receipts. Test-only changes remain valid when they match the goal; weakened assertions do not prove a behavior fix.
- Bound capture time, file sizes, inventory and patch output. Keep ignored secrets out, avoid following symlinks or hard links, disable Git diff/filter helpers, and report incomplete or unavailable captures explicitly.
- Migrate public SQLite state to schema 6 while retaining existing sessions, jobs, images and goal history. Existing goals have no implicit repository binding. Take a coordinated backup before upgrading; older binaries cannot open schema 6.

## 0.7.0 (2026-11-07)

- Add `!goal` and its `!loop` alias for bounded Codex work reviewed after each step by a fresh supervisor session. Keep the worker's session, save candidates before review, and share one execution budget between both phases.
- Add durable status, pause, resume and stop controls, blocked follow-up questions and explicit recovery. Review failures retain the candidate rather than replaying its worker; no-progress reviews stop after three attempts.
- Account for measured phase time even when saving a checkpoint fails, without double charging an already committed phase. Recommend `!goal` when renewing a supervised budget; an ordinary `!work` explicitly opts out of supervision.
- Migrate public SQLite schemas 0–4 to schema 5 while preserving jobs, provider bindings, image inputs and sessions. Back up before upgrading; rollback requires matching pre-upgrade state and binaries.
- Keep supervised goals Codex-only. Claude Code and OpenCode remain available for ordinary tasks. Supervisor filesystem access is read-only; configured MCP permissions still require operator review.

## 0.6.1 (2026-11-06)

- Add `!queue` with current-thread task IDs, accepted order and waiting reasons. Share runner and predecessor predicates with the scheduler; keep other conversations and task content private. Inspection does not call a model, retry a task or predict a start time.
- Warn immediately when a normal message is accepted into a blocked thread, and point to recovery guidance and the blocking task's saved result.
- Order status, default result readback and recovery suggestions by durable acceptance order, so wall-clock rollback cannot select an older workflow or failure.
- Retain public SQLite schema 4, runner bindings and existing recovery rules. This patch does not add parallel workers or update private deployments automatically.

## 0.6.0 (2026-11-06)

### Guided integrations

- Choose Codex, Claude Code or OpenCode before configuring integrations, with explicit `--runner` targeting and private managed MCP defaults for the host adapters. OpenCode model providers, including Go, use the OpenCode adapter; configuring tools does not switch existing Discord threads.
- Add an integration setup CLI for GitHub, Camoufox, OpenAI Docs, Context7 and operator-reviewed MCP servers. Keep account authorization separate from local configuration checks; Camoufox still requires a separately provisioned browser and display.
- Give GitHub CLI a dedicated private credential directory and Docker volume; keep parent GitHub tokens out of agent subprocesses.
- Load bounded, runner-specific integration playbooks on each task. Preserve operator instructions, unrelated JSON settings and conflicting MCP entries; reject unsafe managed files.
- Include the configurator and GitHub CLI in the Codex-only image, with the existing instance lock protecting setup. Exercise packaged setup offline without model calls, account actions or browser downloads.

### Recovery without losing the thread

- Let `!recover` select the task blocking the current thread, or accept an explicit task ID and owner instruction. Reconcile saved state and external action receipts before continuing the same provider-bound session.
- Allow a fresh explicit `!work` budget in a blocked thread to reconcile prior actions and continue without requiring `!new-session`. Replace queued follow-ups atomically while retaining history, image inputs and previously charged execution.
- Preserve the newest accepted recovery budget when recovering an earlier ancestor. Use the durable acceptance sequence rather than mutable timestamps or elapsed totals to order recovery state.
- Include the actual subprocess deadline in workflow prompts and request a checkpoint before that deadline. This guidance does not guarantee timely model completion or renew an exhausted budget automatically.

### Release boundary

- Retain public SQLite schema 4; no new migration is introduced. Keep verified private backups and reconcile external effects before recovery or rollback.
- Keep Claude Code and OpenCode as experimental host adapters, with operator-provided model access and isolation. The Docker image remains Codex-only; live Discord, model, browser and account acceptance remain deployment checks.
- Align the browser package's public version constant and MCP initialization metadata with the coordinated release version.

## 0.5.0 (2026-11-05)

### Discord image input

- Accept still PNG, JPEG and WebP attachments with a caption, without text, or with an explicit `!work` goal in Codex threads. Pass local files as native Codex image inputs on both initial and resumed turns.
- Authorize the owner, server and private forum thread before downloading. Restrict downloads to matching Discord CDN attachment paths, reject redirects, and bound count, declared and streamed bytes, MIME signatures, canvas dimensions and download time.
- Reject image requests explicitly in the Claude Code and OpenCode adapters before downloading; never silently discard images or switch providers.
- Preserve intake order across asynchronous downloads, abort active downloads on shutdown, and remove private runner files after success, failure or cancellation.

### Durable image state and upgrades

- Advance public SQLite state to schema 4. Commit image bytes, media types and SHA-256 digests atomically with jobs; preserve them through queue restart, workflow continuation, manual recovery and verified state snapshots.
- Keep original CDN URLs, filenames and binary images out of Markdown transcripts and automatic memory commits. Images remain private job history; backups now include those bytes.
- Preserve schema-3 jobs and provider bindings during migration. Rolling back to 0.4.0 requires its compatible pre-upgrade snapshot and reconciliation of later work.
- Add offline synthetic regressions for authorization, fetch limits, URL rejection, atomicity, migration, recovery, temporary-file cleanup and actual initial/resume subprocess arguments. No Discord messages, account actions or live inference are used as smoke tests.

## 0.4.0 (2026-11-05)

### Runner adapters

- Add experimental Claude Code and OpenCode host runners alongside the default Codex CLI, with explicit deployment-level selection for new threads.
- Keep provider readiness and queue eligibility independent, without automatic engine or model fallback when another runner is unavailable.
- Validate exact provider sessions, explicit completion events, bounded subprocesses and typed work checkpoints. Preserve cancellation reasons and process-group cleanup.
- Isolate provider configuration variables and private authentication directories. Add runner-aware diagnostics and public-tree checks for private authentication/session paths.
- Document provider-specific permissions, login, model and MCP configuration. OpenCode requires explicit acknowledgement of host execution; its local credential check does not prove remote authentication.

### Durable state and upgrade boundary

- Advance public SQLite state to schema 3 with immutable conversation bindings and job provider snapshots. Legacy conversations, sessions and queued work remain Codex independently of the configured default.
- Preserve provider bindings across restart, manual recovery and session reset. A default-runner change applies only to new threads; uncertain work is never rerouted or replayed automatically.
- Extend verified state backup and restore support to schema 3. Rollback to 0.3.x requires a matching pre-upgrade snapshot and reconciliation of later actions.
- Verify migrations, rollback, scheduling and adapters with offline synthetic regressions. No live Claude/OpenCode account, model or host-sandbox acceptance is claimed by these tests.

### Documentation and offline demo

- Rework the README around concrete use cases, runner support levels and deployment boundaries, with a reproducible three-scenario gallery.
- Add an account-free demo using the actual Engine and SQLite Store with scripted transport and replies. Include raw transcripts and separate optional capture tooling.

### Distribution boundary

- Refresh the README banner and social-preview asset to reflect Codex, Claude Code and OpenCode while retaining the project identity.

- Keep the published Docker image Codex-only. Reject alternative runner selection before initialization writes until independent container acceptance exists.
- Preserve the actual Codex sandbox and the non-root, read-only image acceptance path on Linux amd64 and arm64.

## 0.3.1 (2026-11-05)

### Recovery and ordering fixes

- Retry scoped memory commits after a transient Git failure without leaving staged content behind. Preserve operator staging; tracked deletions and renames remain supported.
- Keep same-thread FIFO order independent of wall-clock adjustments using a durable acceptance ledger. Continued workflows still yield fairly to other threads.
- Measure active execution budgets with a monotonic process clock, including failure accounting. Wall-clock corrections no longer refund or prematurely exhaust the remaining budget.
- Preserve the original timeout/cancellation cause when a gracefully stopping Codex process emits a later generic error.
- Report the installed browser package version during MCP initialization instead of a stale hardcoded version.

### Upgrade boundary

- Public SQLite schema advances from 1 to 2. Legacy jobs retain their previous `(created_at,id)` ordering; new intake receives an immutable sequence.
- Reject incompatible private-deployment databases before mutation. Back up state before upgrade; a binary rollback requires restoring its matching pre-upgrade database snapshot.
- Add offline regressions for transient commit failures, operator staging, clock corrections, continuation/recovery ordering, migration atomicity, variant mismatch and actual MCP initialization metadata.

## 0.3.0 (2026-11-04)

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

## 0.2.0 (2026-11-04)

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

## 0.1.0: Initial public core

- Owner-configured Discord identities and a separate private workspace initializer.
- Single-worker SQLite queue, exact per-thread Codex sessions and explicit interruption recovery.
- Scoped local Markdown memory commits and an optional Camoufox stdio MCP bridge.
- Synthetic templates, offline tests, English documentation and MIT license.
