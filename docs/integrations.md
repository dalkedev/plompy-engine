# Integration setup

Choose the tools your agent needs from a local CLI. The setup command registers
explicit MCP servers or prepares a dedicated GitHub CLI login, then writes short
usage instructions to the private workspace. It does not install every tool,
download skills, or import your personal accounts.

Run setup as the engine's service account, with the same private environment file
and paths used by the service. Stop the engine before changing integrations so a
running task cannot continue with an old tool configuration. No model call or
Discord message is needed for setup.

```sh
npm run integrations
```

The interactive menu first asks which runner's tools to configure: **Codex**,
**Claude Code**, or **OpenCode**. It then offers the supported integrations and
asks for confirmation before changing local configuration. The selected runner
defaults to `SZPONT_RUNNER`, or Codex when that variable is unset.

For scripts and terminals without a TTY, use explicit subcommands and `--runner`
to choose the tools' target:

```sh
npm run integrations -- list
npm run integrations -- status --runner claude
npm run integrations -- status github --runner opencode --json
```

`--runner` only selects where this setup command configures or inspects tools. It
does not edit the service's `SZPONT_RUNNER` setting or switch existing Discord
threads. Each runner still needs its own installed CLI and separate model-account
login. See [runner setup](runners.md) for those prerequisites.

## Included choices

| ID | What setup configures | What you provision |
| --- | --- | --- |
| `github` | Dedicated GitHub CLI configuration and a repository-work playbook | `gh` on a host; your own GitHub login and repository permissions |
| `camoufox` | This repository's local browser MCP bridge and a browser-use playbook | Python environment, pinned browser binary, Linux graphics dependencies and a private X11 display |
| `openai-docs` | OpenAI's remote documentation MCP server | Network access to the official documentation service |
| `context7` | Context7's remote documentation MCP server | Network access; any service limits or account requirements apply independently |
| `custom` | A reviewed local command or remote HTTPS MCP server from a private JSON specification | The server, its dependencies and any separate authentication |

DoubleCrawl, ElevenLabs and Google Drive are not included in the catalog. The
engine does not require those services or ship accounts for them.

Integration playbooks are maintained with the engine and assembled into
`agent/INTEGRATIONS.md` in the private workspace. That file becomes prompt context
for Codex, Claude Code and OpenCode. Entries identify their configured runner;
the agent uses only the entries matching its current thread. These are task
instructions, not a new execution sandbox or a promise that an external tool is
available.

## GitHub

The integration uses the official `gh` CLI rather than introducing another server
that needs a GitHub token. The Docker image built from this source includes `gh`;
on a host, install it using the [official GitHub CLI instructions](https://cli.github.com/).

```sh
npm run integrations -- add github --yes
npm run integrations -- login github
npm run integrations -- status github
```

Or configure and start the interactive login together:

```sh
npm run integrations -- add github --login --yes
```

Complete GitHub's device/browser authorization yourself. Credentials belong on
GitHub's page and in the dedicated private CLI configuration, never in a command
argument, Discord conversation, issue, or source file. Review the access GitHub
shows before approving it.

`GH_CONFIG_DIR` selects the private GitHub configuration directory. When omitted,
the engine uses a `github` directory alongside `SZPONT_STATE_DIR`, outside the
public checkout. A fresh installation starts without a GitHub login; your normal
`~/.config/gh` is not imported. The agent receives the dedicated configuration
path and does not inherit `GH_TOKEN` or `GITHUB_TOKEN` from the launching shell.
On Linux, GitHub CLI may use its private on-disk credential fallback when an OS
credential store is unavailable. Keep that directory and its backups private.

During login, any Git credential-helper configuration written by `gh` goes into
`$GH_CONFIG_DIR/gitconfig`, not the operator's global Git configuration. For a
later HTTPS Git operation, the playbook uses the dedicated CLI explicitly:

```sh
git -c 'credential.helper=!gh auth git-credential' fetch origin
```

Repository access through `gh` uses the same dedicated account. No token needs to
appear in a remote URL or command argument.

Login is not repository authorization by itself: organization SSO, repository
roles and branch protection still apply. The playbook tells the agent to inspect
the repository, preserve unrelated changes, and verify remote writes before
reporting success. A configured integration does not authorize publishing or
merging outside the owner's active task.

## Camoufox on a Linux host

First follow the [browser package installation](../packages/browser/README.md).
The browser archive is a separate download; Python and the browser executable
must already exist. Provision Xvfb or another private local display separately.

```sh
npm run integrations -- add camoufox \
  --python /absolute/source/packages/browser/.venv/bin/python \
  --browser-bin /absolute/browser-install/camoufox-bin \
  --display :99 \
  --yes
```

The integration connects the configured runner to `python -m szpont_browser`,
using the explicit executable, private browser profile and artifact paths. Keep
manual login and automated use on the same profile, browser binary and display.
Finish account login yourself in the headed browser when a task needs it.

This command does not install Python, start Xvfb, download Camoufox, create noVNC,
or authenticate a website. The standard engine container has no browser or
display: Camoufox setup is rejected there. A host Python path does not become
executable inside a container. Use the host deployment for this integration, or
provision and review a separate container-compatible bridge yourself.

The bridge exposes observed page navigation, snapshots, clicks, text entry,
scrolling and screenshots. Page content remains untrusted. An existing browser
login does not grant permission to send messages or publish content.

## Documentation tools

These register explicit remote HTTPS MCP endpoints without downloading an MCP
package, running a package manager, or starting an OAuth authorization flow:

```sh
npm run integrations -- add openai-docs --yes
npm run integrations -- add context7 --yes
```

The catalog uses `https://developers.openai.com/mcp` and
`https://mcp.context7.com/mcp`. Remote services can have availability, rate-limit
or authentication requirements of their own. Setup records configuration; it
does not claim a successful request or purchase a subscription.

## Custom MCP server

Keep the specification outside the source checkout and restrict it to the service
account. A remote server specification looks like this:

```json
{
  "name": "szpont_team_docs",
  "server": {
    "url": "https://mcp.example.com/mcp"
  }
}
```

A local stdio server uses an executable and a separate argument array:

```json
{
  "name": "szpont_team_tools",
  "server": {
    "command": "/absolute/private/tools/team-mcp",
    "args": ["--stdio"]
  }
}
```

```sh
chmod 600 /absolute/private/team-tools.json
npm run integrations -- add custom \
  --spec /absolute/private/team-tools.json \
  --yes
```

Review the server and its dependencies before registration. Setup does not run an
installation command, accept shell command strings, or import arbitrary token
environment variables. Remote URLs must use HTTPS and cannot contain credentials,
query parameters or fragments. Put authentication in a separately reviewed,
private provider/server configuration rather than in this specification.

Custom server names must start with `szpont_` and use only lowercase letters,
digits and underscores. This keeps managed entries identifiable. The `custom`
choice can register more than one server; `remove custom --yes` removes all
matching managed custom entries for the selected runner.

## Runner configuration

The interactive runner choice or explicit `--runner` determines where MCP
configuration is registered. Without an explicit choice, the command uses
`SZPONT_RUNNER`, or Codex when unset:

| Runner | Configuration |
| --- | --- |
| Codex | Remote endpoints use a minimal managed block in private `$CODEX_HOME/config.toml`; local stdio uses `codex mcp add`. Both are inspected with `codex mcp get`. |
| Claude Code | `$CLAUDE_CONFIG_DIR/szpont-mcp.json`, with a `mcpServers` object; `SZPONT_CLAUDE_MCP_CONFIG` overrides this path |
| OpenCode | `$SZPONT_OPENCODE_HOME/szpont-mcp.json`, with an `mcp` object; `SZPONT_OPENCODE_CONFIG` overrides this path |

These paths use the runner's private home. When configuring a non-default runner
without an explicit home, `claude` or `opencode` alongside `SZPONT_STATE_DIR` is
used. Keep setup and service paths consistent when selecting a new default.

For example, configure the same documentation service independently for two
runners:

```sh
npm run integrations -- add openai-docs --runner claude --yes
npm run integrations -- add openai-docs --runner opencode --yes
```

Claude Code and OpenCode automatically load their fixed private `szpont-mcp.json`
file on the next service start when it exists and passes the private-file and JSON
checks. No extra environment setting is needed for that managed default. An
explicit path override takes precedence. When neither an override nor a managed
file exists, the adapter retains its previous behavior without MCP configuration.
Unsafe files or invalid configuration fail validation; they are not silently
loaded. Restart the stopped service after completing setup.

JSONC files are not rewritten. Existing unrelated JSON settings are preserved;
an existing server with different settings produces a conflict instead of being
overwritten. Refer to [runner setup](runners.md) for each adapter's configuration
and execution boundaries.

Existing Discord threads retain their runner. Configuring tools for a new default
does not configure the other providers or change those thread bindings.

OpenCode Go and Zen / Console Models are model providers used through OpenCode,
so they use the same OpenCode integration configuration. Other model providers configured in
OpenCode also share that adapter. Another coding CLI needs its own reviewed engine
adapter before it can appear in this menu; adding a custom MCP server does not add
a new runner.

## Docker

The published **0.5.0 image predates this command**. Until a new image containing
it is published, build from this source under a separate local tag:

```sh
export SZPONT_IMAGE=szpont-engine:integrations-local
docker compose stop engine
docker compose build engine
docker compose run --rm -it engine integrations
docker compose run --rm engine integrations status
docker compose up -d --no-build
```

The Compose deployment persists GitHub configuration in a separate `github-auth`
volume. Like the other private volumes, it survives container replacement and
`docker compose down`; `docker compose down --volumes` deletes it. Do not mount your
personal GitHub configuration into this volume.

The `integrations` entrypoint takes the same exclusive state lock as the service;
a competing engine or setup command exits with code 75. Stop the engine first.
The container still supports Codex only and does not acquire a browser through
this menu.

## Inspect and remove

```sh
npm run integrations -- status
npm run integrations -- status camoufox --json
npm run integrations -- remove camoufox --yes
```

Status distinguishes recorded setup and current local configuration from actual
live readiness. It does not add or change managed integration configuration;
GitHub's authentication check may contact GitHub. Missing executables, missing or
conflicting MCP entries, and an unavailable GitHub login need their own
resolution. A local status result does not prove that a browser launched, an MCP
service connected, a model can use its tools, or a remote action completed.

Removal deletes only matching engine-managed MCP configuration and its generated
workspace instructions. It preserves entries changed independently, existing
browser profiles, GitHub credentials and accounts. To revoke access, also sign
out through the relevant CLI or remove the application's authorization on the
service itself. Inspect any partial external actions before resuming a task.
