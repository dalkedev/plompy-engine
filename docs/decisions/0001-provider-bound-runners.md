# ADR 0001: Provider-bound CLI runners

Status: accepted for experimental host adapters.

## Context

Discord, queueing, memory exports and recovery are independent of any particular
coding CLI. Users may already have Codex, Claude Code or OpenCode access. Their
session identifiers, JSON protocols, authentication stores and execution boundaries
differ, so replacing the executable name is insufficient and risks resuming a
conversation through the wrong tool.

## Decision

Keep one shared engine and a small `runner.ts` dispatch boundary. Preserve the
proven Codex subprocess adapter. Implement separate Claude Code and OpenCode
adapters with their own version guards, arguments, readiness and event parsers.
Each conversation acquires an immutable provider binding at intake; every job
snapshots it. Migration labels all old state Codex. No runtime failure selects
another provider. Claims are filtered by per-provider readiness.

Keep the published container Codex-only. Ship alternative adapters as experimental
host integrations with explicit upstream protocol pins and honest acceptance
limits. OpenCode needs operator isolation and explicit host execution opt-in.
Do not translate Codex sandbox flags into claims about another CLI's isolation.

## Alternatives considered

1. **Single configurable executable:** small change, but cannot preserve protocol,
   permission or resume semantics. Rejected.
2. **Separate engine per CLI:** isolates deployment, but duplicates the queue,
   recovery, privacy and memory machinery. Rejected.
3. **Automatically switch engines on failure:** may replay uncertain actions and
   silently change identity/account. Rejected.
4. **Bundle all CLIs in one container immediately:** wider installation surface
   without independent sandbox acceptance. Deferred.

## Consequences

Provider choice requires a new thread; reset does not rebind existing history.
Each CLI upgrade needs protocol and permission acceptance. Local readiness cannot
prove remote entitlement or quota. The shared engine remains single-worker.
CLI model aliases and provider-side fallback remain upstream behavior; the engine
does not request fallback itself. Explicit MCP tools are operator-trusted processes.

## Follow-up acceptance

Before promoting either host adapter beyond experimental status, perform harmless
live first-turn/resume/cancel/checkpoint tests and verify filesystem/network
boundaries on the target platform. Any future container support must add separate
binaries, auth volumes, pinned artifacts and actual sandbox smoke tests.
