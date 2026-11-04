<div align="center">

# szpont-engine

**Send a task from your phone. Run it on your own machine. Keep the memory.**

A small, self-hosted engine connecting private Discord threads to persistent Codex sessions,
a durable SQLite queue, and readable Markdown memory. Optional Camoufox browser tools over local MCP.

[Quick start](#quick-start) · [Architecture](docs/architecture.md) · [Configuration](docs/configuration.md) · [The timeout problem](docs/articles/a-timeout-is-not-a-failure.md)

`Node.js 24` · `TypeScript` · `SQLite` · `Python` · `MIT`

</div>

## Why it exists

You are away from your desk. You open a private Discord thread, ask your agent to investigate
an idea or work on a project, and come back to the same conversation later. Each thread resumes
its own Codex session. Useful context lives in Markdown you can read, edit and back up yourself.

The interesting part starts when something goes wrong: a child process times out, the host
restarts, or a message delivery becomes uncertain. The engine retains those states instead of
pretending the work never happened.

## What you get

- **One thread, one session.** Follow-ups resume the exact stored session ID.
- **Durable intake.** SQLite WAL, unique message IDs, bounded queues and atomic claims.
- **Explicit recovery.** Running jobs become interrupted on restart. No automatic replay.
- **Owner-only execution.** Required guild, owner, bot and private forum configuration.
- **Readable memory.** Small Markdown instructions, dated notes and generated transcripts in a separate private workspace.
- **Credential discipline.** The Discord token is excluded from child environments; raw Codex stderr is discarded.
- **Optional browser bridge.** Persistent Camoufox profile, observed DOM references and stdio MCP.

**Initial public edition:** one global worker, text-only Discord intake, manual recovery, no
history catch-up after a full outage. The maintained private installation has additional
components; concurrent lanes, editorial scheduling and its publication broker are not included
in this edition. This is an early, inspectable core rather than a general agent framework.

## Quick start

Linux, Node **24.x**, Git, and an authenticated Codex CLI are required. The runner targets
Codex CLI **0.166.0** and its JSON event format. Model/account access is a separate prerequisite;
the MIT license does not include inference or third-party services.

```sh
git clone https://github.com/dalkedev/szpont-engine.git
cd szpont-engine
npm --prefix apps/discord-agent ci --ignore-scripts
npm test
npm run init:workspace -- "$HOME/.local/share/szpont/workspace"
```

That last command creates a **new private Git workspace outside this checkout**, seeds blank
instructions, and refuses to overwrite an existing directory. Edit its `agent/USER.md` and
`agent/POLICY.md` locally before using it.

Copy `.env.example` to a private location, replace all placeholders and set absolute paths.
Create your own Discord application/bot, enable Message Content Intent, and use a private
forum in a server you own. Follow [configuration](docs/configuration.md) for permissions.

```sh
mkdir -p "$HOME/.config/szpont"
cp .env.example "$HOME/.config/szpont/agent.env"
chmod 600 "$HOME/.config/szpont/agent.env"
# Edit this private file, then load it in your shell:
set -a
. "$HOME/.config/szpont/agent.env"
set +a
mkdir -p "$CODEX_HOME" "$SZPONT_STATE_DIR"
chmod 700 "$CODEX_HOME" "$SZPONT_STATE_DIR"
codex login
# Start one engine only. Hold the lock before startup recovery:
flock -n -E 75 "$SZPONT_STATE_DIR/engine.lock" npm --prefix apps/discord-agent start
```

`npm test` builds the engine. Send a harmless task in a new private forum thread after startup.
A successful offline test run does not verify your Discord permissions, model access or browser login.
For unattended hosting, read [deployment](docs/deployment.md). Browser setup is optional and separate.

## Use it from Discord

| Input | Effect |
| --- | --- |
| A normal message | Queue a task; continue this thread's session |
| `!status` | Show accepted jobs and authentication state |
| `!cancel MESSAGE_ID` | Cancel queued work or interrupt a running task in this thread |
| `!recover MESSAGE_ID` | Reconcile and continue a failed/interrupted task |
| `!new-session` | Preserve history and start fresh on the next message |
| `!result MESSAGE_ID` | Read the stored result without rerunning work |

Attachments are rejected. Messages sent during a long outage may never have entered the queue.
Use `!status` to inspect what was actually accepted.

## Keep code public and memory private

```text
szpont-engine/                 # Public source; safe example templates only
~/.config/szpont/agent.env     # Private credentials and deployment IDs
~/.local/share/szpont/
  workspace/                  # Private AGENTS.md + agent/ + its own Git history
  state/                      # Queue and session mapping
  codex/                      # Private Codex login/config
  browser/                    # Optional private browser profile
  artifacts/                  # Private task output
```

Never point the private workspace's Git remote at this public repository. The engine makes
local commits of selected Markdown; it does not push them. Treat transcripts and generated
artifacts as private even when they contain no tokens.

## Explore the code

| Path | Responsibility |
| --- | --- |
| `apps/discord-agent/src/config.ts` | Deployment identity, intake authorization, child environment |
| `apps/discord-agent/src/store.ts` | Job state, deduplication, sessions, recovery |
| `apps/discord-agent/src/engine.ts` | Execution and notification lifecycle |
| `apps/discord-agent/src/codex.ts` | Bounded subprocess protocol and cancellation |
| `apps/discord-agent/src/workspace.ts` | Context, transcripts, scoped local memory commits |
| `packages/browser/` | Optional Camoufox MCP tools and offline checks |
| `examples/workspace/` | Synthetic starting instructions, never the author's memory |

## Boundaries

A job finishing is not proof that a website action succeeded. Check the actual destination.
There is no exactly-once guarantee for external services, no automatic recovery of ambiguous
writes, and no protection against every prompt injection. Filesystem permissions and the
configured Codex sandbox remain part of the deployment's trust boundary. Same-UID processes
are not isolated from each other merely because environment variables were filtered.

A ready-to-copy [GitHub Actions template](examples/github-actions/checks.yml) is included;
it is inactive until a maintainer enables it.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
