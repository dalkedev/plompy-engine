# Configuration

All identities below belong to **your own deployment**. No author account or channel is a default.

| Variable                           | Required | Meaning                                                       |
| ---------------------------------- | -------- | ------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`                | yes      | Your bot token; never passed to model children                |
| `PLOMPY_DISCORD_GUILD_ID`          | yes      | Your Discord server ID                                        |
| `PLOMPY_DISCORD_OWNER_ID`          | yes      | That server's owner ID                                        |
| `PLOMPY_DISCORD_BOT_ID`            | yes      | Your bot user ID                                              |
| `PLOMPY_DISCORD_PARENT_CHANNEL_ID` | yes      | Private forum channel ID                                      |
| `PLOMPY_WORKSPACE`                 | yes      | Absolute path to your separate private Git workspace          |
| `PLOMPY_STATE_DIR`                 | yes      | Absolute path for SQLite and singleton lock                   |
| `PLOMPY_ARTIFACTS_DIR`             | yes      | Absolute path for task output                                 |
| `CODEX_HOME`                       | Codex default      | Absolute private Codex configuration/login/session directory  |
| `PLOMPY_BROWSER_DIR`               | no       | Optional browser state; defaults to `/var/lib/plompy/browser` |
| `PLOMPY_CODEX_BIN`                 | no       | Executable path/name; default `codex`                         |
| `PLOMPY_TASK_TIMEOUT_MS`           | no       | 1,000–3,600,000 ms; default 1,200,000                         |

IDs must be 17–20 decimal digits. Enable Discord Developer Mode to copy IDs. Create a bot
application and enable its privileged Message Content Intent. Authorize it for your server
with the permissions required to view the private forum, send messages in threads, read message
history and attach files. Do not grant Administrator merely to make setup easier.

The forum must deny visibility to `@everyone`. The adapter rejects explicit visibility grants
to identities other than the configured owner and bot. Administrators can still bypass channel
visibility, so this is not a promise of secrecy from server administrators. The configured owner
must actually own the server; arbitrary members are not supported by this first edition.

Use the same loaded `CODEX_HOME` for `codex login` and the engine. No model is hardcoded; the
owner configures the CLI account/model. The process adapter targets CLI 0.166.0; upgrading it
requires checking arguments, login status and JSON events against the offline protocol tests.

The engine does not load `.env` itself. Source only your own trusted private environment file
or use your service manager's environment-file support. Do not paste tokens into Discord.

For optional browsing, map the engine profile path explicitly into the MCP server environment,
as shown in [the browser guide](../packages/browser/README.md#connect-the-public-engine-to-this-bridge).

## Alternative runners

`PLOMPY_RUNNER` selects `codex` (default), `claude`, or `opencode` for new threads.
Existing thread and job bindings are immutable. No auth or model failure switches
providers. See [runners](runners.md) for the exact execution and credential boundaries.

| Variable | Required | Meaning |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude default | Absolute private Claude login/configuration/session directory |
| `PLOMPY_CLAUDE_BIN` | no | CLI executable; default `claude` |
| `PLOMPY_CLAUDE_MODEL` | no | Explicit model; otherwise the CLI's configured default |
| `PLOMPY_CLAUDE_EFFORT` | no | `low`, `medium`, `high`, `xhigh`, or `max`; model support is account-specific |
| `PLOMPY_CLAUDE_MCP_CONFIG` | no | Absolute private trusted MCP JSON file |
| `PLOMPY_OPENCODE_HOME` | OpenCode default | Absolute private root for isolated XDG config/data/state/cache |
| `PLOMPY_OPENCODE_BIN` | no | CLI executable; default `opencode` |
| `PLOMPY_OPENCODE_MODEL` | OpenCode default | Explicit `provider/model`; no automatic fallback |
| `PLOMPY_OPENCODE_CONFIG` | no | Absolute private JSON containing only `provider` and/or `mcp` |
| `PLOMPY_OPENCODE_HOST_EXECUTION` | to run OpenCode | Must be exactly `allow`; acknowledges operator-managed host isolation |

No parent provider API keys are automatically passed to model subprocesses.
The supplied container supports Codex only; alternative adapters need host setup.

## Work budgets and maintenance

Work sessions are opt-in owner commands, not environment configuration: `!work 30m <goal>`
or `!work 2h <goal>`. The fixed limits are 1–120 minutes of active runner execution and 32
completed steps. Each process also respects `PLOMPY_TASK_TIMEOUT_MS`; it cannot exceed the
remaining work budget. Queue, authentication and export waits do not consume active time.
The CLI 0.166.0 adapter passes the bundled JSON output schema for new and resumed work turns.

Transcript export and local memory commits run independently of model authentication.
A pass services at most two due threads; failures back off from one second to five minutes.
The engine's regular 30-second tick determines when a due retry is attempted while idle.
`!status` separates delayed exports/commits from execution and final delivery state.
See [work sessions](work-sessions.md) and [state backups](state-backups.md) before upgrading.

Supervised `!goal` / `!loop` sessions use these same budget ceilings and require
a Codex-bound thread. They add no environment setting or model override. See
[supervised goals](supervised-goals.md) before upgrading to schema 6 in 0.8.0.
For automatic code evidence, bind an explicit repository with `--repo`; this is a
per-goal option, not an environment variable. See [code diff evidence](goal-code-diffs.md)
for allowed paths, capture limits and `--no-repo` recovery behavior.
