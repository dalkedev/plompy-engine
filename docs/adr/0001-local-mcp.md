# ADR 0001: Separate local MCP tools from Discord agent execution

Status: accepted for the unreleased local implementation

Date: 2026-11-12

## Context

The existing engine owns Discord conversations, runner sessions, jobs and recovery.
Its Docker image installs Codex and does not expose a tool server. A user with an
existing local coding agent needs tools without a second agent, Discord account or
model account inside the container.

## Decision

Add a small ESM package using the same locked official MCP SDK as the credential
bridge. Expose authenticated Streamable HTTP at `/mcp`. The external client owns
reasoning, model selection and its own permissions. Plompy owns the configured
tool allowlist, bounded network access, private credentials and durable artifacts.

Keep the Discord entry point, its Compose file and runner adapters unchanged.
Reuse the integration catalog, vendor endpoint definitions, credential validation,
and pinned Playwright installation. Extend the existing integration CLI with
`--mode local` instead of creating a competing setup experience.

Provide a lightweight image and an optional Chromium image. Both run as UID 1000,
publish only host loopback, and use separate persistent configuration, secret and
artifact volumes. The browser keeps Chromium's sandbox, routes reads through the
DNS-pinned HTTP adapter, and blocks raw networking with a dead proxy. It exposes
page reading, not unrestricted clicking or code execution.

## Alternatives

1. Run OpenCode inside the existing engine image. Rejected: it couples this mode to
   runner/Discord lifecycle and duplicates the user's agent and model account.
2. Forward every upstream tool. Rejected: names and read-only annotations do not
   prevent form submissions, embedded browser actions or arbitrary side effects.
3. Build a general service platform with users, billing and a hosted control plane.
   Rejected: unnecessary for a local open-source tools service.

## Consequences

The same endpoint works independently of the model provider. Codex, Claude Code and
OpenCode receive separate configuration examples. Ollama, when supported by the
chosen client and model, is configured in that client, not inside Plompy.

The initial research profile intentionally excludes arbitrary custom MCP servers,
TinyFish autonomous actions and Camoufox. Existing runner integrations remain
available in their original mode. Remote search needs the operator's provider and
may incur provider charges. No data-locality promise is inferred from Docker or
from choosing a local model.

Stateless HTTP is sufficient for bounded request/response tools. There are no
background MCP tasks, sampling or OAuth delegation. Disconnect/deadline signals
cancel supported operations; remote completion is not reversible and calls are
never replayed automatically. Operators restart after changing configuration.

## Verification

Use package tests for protocol, permission boundaries, provider failures, private
paths, redaction and idempotent export. The Docker acceptance suite checks real
sandboxed rendering and persistence. Actual client tests use isolated configuration
and a deterministic local model fixture, clearly separate from real model quality
or paid provider testing. See the [acceptance instructions](../../packages/local-mcp/test/README.md).
