# Security

This early single-owner engine runs code and an optional authenticated browser on your machine.
Treat the service account, configured model, plugins and host filesystem as trusted components.
Environment filtering does not isolate processes sharing a Unix UID. Browser URL guards are
best-effort navigation checks, not a network firewall. Prompt instructions are not an enforcement
boundary for hostile pages or generated code.

Use a dedicated account, explicit task authority, private state directories and least-privilege
credentials. Keep the public engine source separate from your private workspace and backups.
Do not grant a model unrestricted administrator credentials.

For a suspected vulnerability, use GitHub's private vulnerability reporting **if the repository
shows that option**. Otherwise use the maintainer contact on the linked GitHub profile before
sending sensitive details. Do not post secrets, cookies, raw logs or exploit details publicly.
No response-time SLA or independently audited security claim is offered.

## Runner-specific boundaries

Codex, Claude Code and OpenCode do not share a permission or sandbox implementation.
The [runner guide](docs/runners.md) states each adapter's boundary and acceptance limits.
Claude uses mandatory native Bash sandboxing and restricted file tools; explicitly
configured MCP services remain trusted processes outside that Bash sandbox.
OpenCode requires explicit host execution opt-in and operator-managed OS isolation.
Its tool permissions cannot confine arbitrary shell commands. The supplied Docker
image remains Codex-only and rejects other selected runners.

Keep every provider's credentials, session history and configuration private.
Changing the default does not migrate existing conversations or credentials.
Provider failures never invoke an automatic fallback.

## SQLite runtime requirement

Version 0.10.0 requires official Node 26 LTS (at least 26.13.0) with embedded
SQLite 3.54.0 or newer. Runtime checks compare metadata with an in-memory SQLite
query before opening state; an unsupported or inconsistent runtime is rejected.
This replaces the affected Node 24 runtime shipped by 0.9.x and earlier.

[CVE-2026-119375](docs/runtime-known-findings.md) concerns opening a less-trusted
SQLite database and crafted sibling WAL. Older releases remain affected. An npm
install or OS sqlite3 update does not replace Node's embedded SQLite. Keep state
and backups private and accept only trusted provenance even with a patched runtime.
