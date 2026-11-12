# Documentation

- **[Upgrade to Plompy 0.12](migration-plompy.md)**: retain existing sessions, private state, browser identity and Docker volumes.

plompy-engine connects a private Discord forum to persistent coding CLI sessions on
your own Linux machine. The public edition runs one shared worker. Start with Codex;
Claude Code and OpenCode are experimental host adapters, and the published Docker
image supports Codex only.

## Start here

1. Follow the [quick start](../README.md#quick-start) to build the engine, initialize a
   separate private workspace and connect your own Discord bot and Codex account.
2. Run the [deployment doctor](doctor.md) as the service user. Local readiness is a
   prerequisite; verify a harmless live task separately on your installation.
3. Follow [your first supervised code goal](first-goal.md) using the supplied acceptance fixture or an existing project.
   It covers repository binding, reviewing evidence, controls and recovery.

| What you need                                          | Guide                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Choose a normal task, `!work` or `!goal`               | [First supervised goal](first-goal.md#choose-the-right-command) |
| Look up everyday Discord commands                      | [Command reference](first-goal.md#command-reference)            |
| Understand worker and supervisor decisions             | [Supervised goals](supervised-goals.md)                         |
| Understand saved before/after patches and their limits | [Code diff evidence](goal-code-diffs.md)                        |
| Manage budgets, queue state and uncertain attempts     | [Work sessions](work-sessions.md)                               |
| Create a new private installation                      | [Guided setup](setup.md)                                        |
| Configure private paths, identities and CLI access     | [Configuration](configuration.md)                               |
| Select and authenticate a runner                       | [Runners](runners.md)                                           |
| Run on a Linux host or in a container                  | [Deployment](deployment.md) · [Docker](docker.md)               |
| Diagnose local setup and opt-in Discord REST access    | [Doctor](doctor.md)                                             |
| Set up GitHub, browser, documentation or MCP tools     | [Integrations](integrations.md)                                 |
| Send still images to Codex                             | [Image input](image-input.md)                                   |
| Back up state, upgrade or roll back                    | [State backups](state-backups.md) · [Releases](releases.md)     |
| Understand intake, persistence and execution           | [Architecture](architecture.md)                                 |
| Reproduce the synthetic README captures                | [Offline demo](demo.md)                                         |
| Report a security issue or contribute                  | [Security](../SECURITY.md) · [Contributing](../CONTRIBUTING.md) |
| Track evidence required for a stable contract          | [Road to 1.0](../ROADMAP.md)                                    |

## Optional browser

The [Camoufox browser guide](../packages/browser/README.md) covers the separate Python
package, pinned browser provisioning, persistent profile, manual login and local stdio
MCP setup. Browser installation and account login are separate from engine setup.

## Deeper reading

[A timeout is not a failure](articles/a-timeout-is-not-a-failure.md) explains why local
task state cannot prove whether an external action happened. The
[supervised-goal validation record](verification/2026-11-07-supervised-goals.md) describes
what was exercised and which deployment assumptions still need verification.
For source navigation, use the [source map](../README.md#explore-the-code).
The [brand guide](brand.md) contains reusable visual assets.

## Keep runtime data private

The repository contains synthetic workspace templates. Your instructions, notes,
transcripts, SQLite state, authentication, browser profile, code projects and output
belong in private directories outside this checkout. The workspace initializer creates
a separate local Git history and does not configure a public remote.

The [0.9 installation validation record](validation-0.9.md) separates automated,
host, Discord transport and model/soak results.

The [Node 26 runtime record](runtime-known-findings.md) explains the 0.10.0
minimum version, linked SQLite checks and remediation of the older runtime finding.
