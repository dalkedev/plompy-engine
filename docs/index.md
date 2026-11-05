# Documentation

szpont-engine connects a private Discord forum to persistent CLI sessions (Codex, Claude Code, or OpenCode) on your own
Linux machine. Start with the engine; add browser tools only when your tasks need them.

## Getting started

The [quick start](../README.md#quick-start) walks through installing dependencies, running the
offline checks, creating a private workspace, and starting one instance. You need your own
Discord bot and server, Codex authentication, and model/account access.

| Guide                              | What you will find                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| [Offline demo](demo.md)          | Reproducible synthetic Engine/Store scenarios and README capture tooling                       |
| [Architecture](architecture.md)    | Intake, one-worker execution, session identity, job and delivery state, recovery              |
| [Image input](image-input.md) | Private Discord images, Codex resume, limits and attachment persistence |
| [Work sessions](work-sessions.md)  | Explicit budgets, typed checkpoints, fair scheduling, pause and recovery                      |
| [State backups](state-backups.md)  | Verified SQLite snapshots, restore and migration rollback                                     |
| [Runners](runners.md)             | Tool choice, version pins, provider-bound sessions and experimental host adapters             |
| [Configuration](configuration.md)  | Required deployment identities, environment variables, private forum permissions, Codex setup |
| [Deployment](deployment.md)        | Linux hosting, the singleton lock, private state, backups, acceptance checks                  |
| [Docker](docker.md)                | Non-root container setup, sandbox prerequisites, private volumes, offline smoke test          |
| [Doctor](doctor.md)                | Read-only local configuration and filesystem diagnostics                                      |
| [Releases](releases.md)            | Versioned images, verification gates, upgrades, and rollback                                  |
| [Security](../SECURITY.md)         | Trust boundaries, credential handling, sensitive reports                                      |
| [Contributing](../CONTRIBUTING.md) | Local checks, test expectations, pull request guidance                                        |
| [Road to 1.0](../ROADMAP.md)       | Evidence required before promising a stable engine contract                                   |

## Optional browser

The [Camoufox browser guide](../packages/browser/README.md) covers the separate Python package,
pinned browser provisioning, persistent profile, manual login, local stdio MCP setup, and
offline verification. Browser installation and account login are separate from engine setup.

## Technical notes

[A timeout is not a failure](articles/a-timeout-is-not-a-failure.md) explains why local task
state cannot prove whether an external action happened, and why recovery requires inspection.

For implementation details, start with the [source map](../README.md#explore-the-code).
The [brand guide](brand.md) provides the project name, palette, and reusable visual assets.

## Keep runtime data outside the source

The repository contains synthetic workspace templates. Your instructions, notes, transcripts,
SQLite state, Codex authentication, browser profile, and output belong in private directories
outside this checkout. The workspace initializer creates a separate local Git history and does
not configure a public remote.
