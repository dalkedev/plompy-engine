# Choose a runner

The public engine can dispatch to **Codex**, **Claude Code**, or **OpenCode**.
Codex remains the default. The Claude Code and OpenCode adapters are experimental
Linux host integrations: their protocol tests use synthetic CLIs, not real accounts.
The published Docker image packages and verifies **Codex only**; it refuses a
non-Codex `SZPONT_RUNNER` rather than pretending another runner has the same sandbox.

| Runner | CLI requirement | Readiness | Execution boundary | Image input |
| --- | --- | --- | --- | --- |
| `codex` | Codex CLI 0.166.0 | Local `login status` | Existing `workspace-write` sandbox and explicit writable directories | Still PNG/JPEG/WebP, including resumed turns |
| `claude` | Claude Code >=2.1.285, <3 | Version and local `auth status` | Restricted mode, mandatory native Bash sandbox, explicit tools and MCP | Rejected before fetch |
| `opencode` | OpenCode 1.19.5 | Pinned version, local selected-model credential entry | Service-account host permissions; operator isolation and explicit opt-in required | Rejected before fetch |

These checks do not prove remote model entitlement, available quota, actual provider
sandbox operation, or successful external actions. The engine never switches runners or requests a fallback model. Upstream CLI
model aliases and provider-side model fallback policies can still apply. The engine still has **one global worker**.
A different runner does not add parallel workers or a scheduler.

The [integration setup CLI](integrations.md) can configure tools for all three
runners. Its interactive menu asks for the runner first; `--runner claude`, for
example, selects the target explicitly. This tool selection does not
change the service default or an existing thread's runner. A different model
provider within OpenCode uses its existing adapter; another coding CLI requires
a separate engine adapter.

## Bindings and upgrades

Set `SZPONT_RUNNER=codex|claude|opencode` in your private environment file before
starting an instance. This selects the runner for **new Discord conversations**.
Existing conversations and queued jobs retain their stored provider. A schema-3
migration labels all legacy conversations and jobs `codex`, even when the newly
configured default is different. Provider bindings cannot be changed in place.

`!new-session` cancels queued work and clears the session; it retains the runner
binding and history. To use a different runner, select the new default and create
a new Discord thread. Recovery retains the failed job's provider. A saved UUID
or OpenCode session identifier is never passed to a different adapter. Existing
session uniqueness is retained across all providers as an additional collision guard.

Stop the engine and take a [verified state snapshot](state-backups.md) before
upgrading. Version 0.8.0 uses schema 6 for private images, supervised goal history and code-diff
evidence; 0.7.0 and earlier reject that schema. Earlier engines also reject schemas newer than their own. Rollback requires compatible pre-upgrade
state and separate reconciliation of later accepted work. Keep the binaries and
private auth directories needed by existing conversations after changing a default.

See [image input](image-input.md) for attachment limits, private storage and recovery.

## Claude Code on a Linux host

Install a compatible official Claude Code CLI and its Linux sandbox prerequisites
(`bubblewrap` and `socat`). Follow the upstream [authentication guide](https://code.claude.com/docs/en/authentication)
and [sandbox guide](https://code.claude.com/docs/en/sandboxing). Run login as the
service account with the same private configuration directory:

```sh
export SZPONT_RUNNER=claude
export CLAUDE_CONFIG_DIR=/srv/szpont/claude
export SZPONT_CLAUDE_BIN=claude
export SZPONT_CLAUDE_MODEL=sonnet
export SZPONT_CLAUDE_EFFORT=high
mkdir -p "$CLAUDE_CONFIG_DIR"
chmod 700 "$CLAUDE_CONFIG_DIR"
claude auth login
npm run doctor -- --check-login
```

The remaining Discord, workspace, state, artifacts and browser variables are still
required. `CODEX_HOME` is only required when Codex is the configured default; keep
an explicit value if old Codex conversations also exist.

The adapter uses `--print`, streamed JSON, explicit session IDs, and a bundled JSON
schema for work checkpoints. It disables settings discovery, hooks, custom slash
commands and automatic plugins; project configuration cannot opt out of the
required sandbox. It uses `dontAsk` with explicit tools rather than bypassing
permission checks. Unsupported sandbox environments fail rather than falling back
to unsandboxed Bash. Do not loosen the host's security settings to hide a failed check.

For optional MCP tools, the integration CLI writes trusted `mcpServers` into
`$CLAUDE_CONFIG_DIR/szpont-mcp.json`. On service start, the adapter automatically
loads this fixed file when it exists and passes the private-file and JSON checks.
Set `SZPONT_CLAUDE_MCP_CONFIG` to an absolute private JSON path to override it.
With no override and no managed file, no MCP configuration is supplied. Other
Claude settings and project MCP discovery remain disabled. Restart the service
after changing integration configuration.

MCP servers and WebFetch/WebSearch are not enclosed by the Bash sandbox; review
their permissions independently. No browser login or account access transfers from
Codex automatically. A real harmless first-turn acceptance test is still required.

## OpenCode on an operator-isolated Linux host

Use a dedicated service account and an operator-managed VM or container boundary
appropriate for generated shell commands. **OpenCode's tool permissions are not
an OS sandbox.** Bash and delegated tasks retain service-account host access;
`external_directory` rules cannot confine arbitrary shell commands.

Install the pinned official OpenCode CLI, then load private paths for the login
process as well as the engine:

```sh
export SZPONT_RUNNER=opencode
export SZPONT_OPENCODE_HOME=/srv/szpont/opencode
export SZPONT_OPENCODE_BIN=opencode
export SZPONT_OPENCODE_MODEL=your-provider/your-model
export SZPONT_OPENCODE_HOST_EXECUTION=allow
export HOME="$SZPONT_OPENCODE_HOME"
export XDG_CONFIG_HOME="$SZPONT_OPENCODE_HOME/config"
export XDG_DATA_HOME="$SZPONT_OPENCODE_HOME/data"
export XDG_STATE_HOME="$SZPONT_OPENCODE_HOME/state"
export XDG_CACHE_HOME="$SZPONT_OPENCODE_HOME/cache"
mkdir -p "$SZPONT_OPENCODE_HOME"
chmod 700 "$SZPONT_OPENCODE_HOME"
opencode auth login
npm run doctor -- --check-login
```

Replace `your-provider/your-model` with a model available to your own account.
The adapter accepts local API or OAuth entries in
`$SZPONT_OPENCODE_HOME/data/opencode/auth.json`; it does not auto-import parent
API keys or remote `.well-known` credentials. A local readiness PASS does not
validate those credentials against a remote provider.

**OpenCode Go is a model provider and subscription, not a separate CLI runner.**
If your own account already has Go access, select it through OpenCode's `/connect`
flow, then choose an available model with `/models`. Set
`SZPONT_OPENCODE_MODEL=opencode-go/<model-id>` using the real model ID; the angle
brackets are a placeholder. Zen / Console Models is a separate model provider
with usage-based billing. Both use the same OpenCode adapter and MCP tools, as do
other providers configured in OpenCode. Account access and credentials are
separate from integration setup. See the official [Go guide](https://opencode.ai/v2/docs/console/go/)
and [Console Models guide](https://opencode.ai/v2/docs/console/models/). No live Go
or Zen account acceptance test is implied by local configuration checks.

For optional MCP settings, the integration CLI writes
`$SZPONT_OPENCODE_HOME/szpont-mcp.json`, which can also hold trusted provider
configuration. On service start, the adapter automatically
loads this fixed file when it exists and passes the private-file and JSON checks.
An explicit `SZPONT_OPENCODE_CONFIG` absolute private JSON path takes precedence.
The JSON can contain only `provider` and/or `mcp` objects; unrelated top-level keys
are rejected. With no override and no managed file, no additional provider/MCP
configuration is supplied. Restart the service after changing integrations.

The child HOME and XDG paths point to the private OpenCode runtime root, so the
operator's normal `$HOME/.opencode` is not discovered. The adapter fixes the selected
model/provider and built-in `build` agent, disables
project configuration, external skill and plugin discovery, sharing and automatic
updates, and supplies noninteractive tool permissions. Unknown tools are denied;
only explicitly configured MCP server names are permitted. Keep the private
runtime root operator-controlled: this is configuration hygiene, not process isolation.
Host-managed OpenCode policy (for example `/etc/opencode`) and private global
configuration remain trusted administrator inputs; they must not override the
adapter policy. The adapter does not isolate a process from its host administrator.

OpenCode streams `run --format json` events and resumes an exact `ses_...` ID.
A successful turn requires exit 0, valid session events, final `stop` evidence and
text. Work checkpoints are requested in the prompt and validated by the engine;
this CLI has no schema flag equivalent to the Codex/Claude adapters. Invalid
checkpoints stop the work session and need inspection instead of being replayed.

## Credentials, diagnostics and acceptance

The model subprocess receives an allowlisted environment and only its selected
provider's configuration variables. The Discord token, unrelated provider API
keys and arbitrary discovery overrides are not forwarded. Files and processes
sharing a Unix user still require host isolation; environment filtering is not
sufficient to protect them.

`npm run doctor` only checks the selected default runner. Add `--check-login` for
its local readiness probe; it does not sign in, run a model or contact Discord.
`!status` shows this thread's provider and its readiness; jobs for unavailable
providers wait while eligible jobs for other providers can run. Private transcript
exports record provider identity without exposing CLI session IDs in Discord.

Offline regression tests cover configuration isolation, migration, provider
bindings, recovery, mixed-provider readiness, exact session resume, cancellation,
limits and malformed events. They do not replace a live first-turn and sandbox
acceptance test on your deployment. No live Claude Code or OpenCode account test
is represented as having passed in this change.

Upstream references: [Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Claude headless mode](https://code.claude.com/docs/en/headless),
[OpenCode CLI](https://opencode.ai/docs/cli/), and the
[pinned OpenCode run protocol](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/cli/cmd/run.ts).
