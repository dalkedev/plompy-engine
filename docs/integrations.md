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

| ID            | What setup configures                                                                 | What you provision                                                                               |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `github`      | Dedicated GitHub CLI configuration and a repository-work playbook                     | `gh` on a host; your own GitHub login and repository permissions                                 |
| `camoufox`    | This repository's local browser MCP bridge and a browser-use playbook                 | Python environment, pinned browser binary, Linux graphics dependencies and a private X11 display |
| `openai-docs` | OpenAI's remote documentation MCP server                                              | Network access to the official documentation service                                             |
| `context7`    | Context7's remote documentation MCP server                                            | Network access; any service limits or account requirements apply independently                   |
| `playwright`  | Pinned local Playwright MCP, headless with an isolated browser session                 | Optional Node package, Chromium or a reviewed executable, and Linux browser libraries            |
| `perplexity`  | Perplexity search and reasoning tools through OAuth or the API-key bridge               | Your own Perplexity API organization, authorization and usage allowance                           |
| `firecrawl`   | Hosted Firecrawl tools through OAuth, API key, or limited keyless access                | Network access and the service's current team, plan and rate limits                              |
| `tinyfish`    | Hosted TinyFish search, page extraction and remote browser tools                       | TinyFish authorization; funded usage for tools outside its free allowance                        |
| `posthog`     | Hosted PostHog MCP with the catalog's read-only tool restriction                        | Your own PostHog project access through OAuth or a scoped personal API key                        |
| `custom`      | A reviewed local command or remote HTTPS MCP server from a private JSON specification | The server, its dependencies and any separate authentication                                     |

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

## Playwright on a Linux host

Playwright is a separate local browser choice. Install its optional locked package,
then explicitly download its matching browser as the service account:

```sh
npm ci --prefix packages/playwright
node packages/playwright/install-browser.mjs --cache-dir "$SZPONT_BROWSER_DIR/playwright/cache"
npm run integrations -- add playwright --yes
```

The package pins Microsoft's `@playwright/mcp` to **0.0.85**. The managed launcher
uses headless mode and an isolated session, keeps the Chromium sandbox enabled,
and places its temporary output in private per-launch directories. It does not
copy a personal browser profile or reuse an existing account session. These modes
use the [official Playwright MCP options](https://github.com/microsoft/playwright-mcp).

Install the browser's Linux system libraries separately as the host administrator.
The registration command does not install packages, download browsers or start a
display. To use an already provisioned compatible browser instead of the downloaded
one, supply `--browser-bin /absolute/browser/executable` when adding Playwright.
That executable and its dependencies must be available to the service account.

On Ubuntu hosts with restricted user namespaces, a `host-sandbox-unavailable`
acceptance failure may require an administrator-reviewed, exact-executable
AppArmor policy. The [Playwright package guide](../packages/playwright/README.md)
includes the policy generator and explains the separate load step. Keep Chromium's
sandbox enabled; the configurator never disables system restrictions.

This choice currently targets a host installation. The core engine image does not
include the optional Playwright package, Chromium or its system libraries. A
headless browser still makes real network requests and can submit forms; use it
within the active task's authority and inspect the target before consequential
actions. Isolated browser state is not a host-process security boundary.

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

## Hosted research and analytics tools

The four hosted integrations use the same catalog and managed MCP configuration
for **Codex, Claude Code and OpenCode**. They do not change the thread's model or
runner. Each defaults to native OAuth configuration:

```sh
npm run integrations -- add perplexity --yes
npm run integrations -- add firecrawl --yes
npm run integrations -- add tinyfish --yes
npm run integrations -- add posthog --yes
```

These commands only register local configuration. They do not connect to the
service, start an OAuth flow, authenticate remotely, list tools, or make a billable tool
call. Complete the selected client's native MCP authorization separately as the
same service account. Szpont's noninteractive worker does not complete browser
sign-in for you. A native OAuth entry is useful only when that installed client
can finish and retain the service's authorization; verify this on your deployment.

| Service | Native OAuth URL | API-key URL and upstream authentication |
| --- | --- | --- |
| [Perplexity](https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server) | `https://api.perplexity.ai/mcp` | Same URL; `Authorization: Bearer` |
| [Firecrawl](https://docs.firecrawl.dev/mcp-server) | `https://mcp.firecrawl.dev/v2/mcp-oauth` | `https://mcp.firecrawl.dev/v2/mcp`; `Authorization: Bearer` |
| [TinyFish](https://github.com/tinyfish-io/tinyfish-mcp-server) | `https://agent.tinyfish.ai/mcp` | Same URL; the managed bridge sends `X-API-Key` |
| [PostHog](https://posthog.com/docs/model-context-protocol/faq) | `https://mcp.posthog.com/mcp?readonly=true` | `https://mcp.posthog.com/mcp`; `Authorization: Bearer` plus `x-posthog-read-only: true` |

The PostHog query is a reviewed fixed catalog URL. It does not permit query
parameters in arbitrary custom server URLs.

### API keys through a private credential file

For unattended clients, the optional provider-neutral stdio bridge reads a private
key file and attaches the service's authentication header to its fixed HTTPS
endpoint. Install that package explicitly before selecting API-key mode:

```sh
npm ci --prefix packages/mcp-bridge
npm run integrations -- add perplexity \
  --credential-file /absolute/private/credentials/perplexity.key \
  --runner codex \
  --yes
```

Prepare the key file using your private editor or secret manager. It contains the
raw key on one line, with no JSON, shell assignment or `Bearer` prefix. Use an
owned `0600` file in an owned `0700` directory; symlinks and hard links are refused.
The file must stay outside the source checkout and every managed workspace,
state, artifact, browser, GitHub and runner-configuration directory. A separate
`/absolute/private/credentials` directory is appropriate. Pass its **path**, not
a key, on the command line. Managed runner configuration records that path and
the local bridge command, never the key itself.

`--credential-file` selects `api-key` mode unless an explicitly supplied `--auth`
conflicts. `--auth api-key` requires a credential file. `--auth oauth` uses the
native URL and accepts no credential file. These options work for each of the four
services and with `--runner codex|claude|opencode`. Choose one authentication mode
for a managed entry; to change it, remove that matching entry and add it again
while the engine is stopped. Removal does not revoke the external credential.

The bridge provides a common transport, not an account or a secret vault. The
service account must be able to read the credential file when a runner launches
the bridge. Other processes with that account's filesystem access can also read
it. Keep credentials and their backups outside conversations and public reports.

### Service capabilities and billing

**Perplexity** adds web search and research/reasoning tools. Both OAuth and API-key
requests use Perplexity's API billing; OAuth selects an API organization that can
pay for usage. Do not infer an API allowance from a consumer Pro/Max subscription
or a Computer credit balance; review the selected API organization separately.
See [MCP authentication and billing](https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server)
and the [official plan comparison](https://www.perplexity.ai/help-center/en/articles/11187416-which-perplexity-subscription-plan-is-right-for-you).

**Firecrawl** also offers explicit keyless mode:

```sh
npm run integrations -- add firecrawl --auth keyless --yes
```

It uses the API endpoint without a credential file and currently exposes a limited
Search, Scrape and Parse surface. OAuth and API keys can unlock more tools or usage
according to the team's plan. A keyless entry is not unlimited access; check the
[official mode and rate-limit guidance](https://docs.firecrawl.dev/mcp-server/keyless).

**TinyFish** includes search and page extraction alongside remote browser sessions,
automation and monitoring. Some operations create persistent remote resources or
spend wallet credits. Its free search/fetch allowance does not make browser and
automation work free. Use only the capabilities needed for the task and reconcile
an uncertain remote run before retrying it. See [TinyFish's MCP tools and usage rules](https://docs.tinyfish.ai/mcp-integration).

**PostHog** connects the operator's existing project to MCP. It does not install an
analytics SDK, add website tracking, or collect Szpont usage telemetry. The catalog
sets PostHog's actual server-side read-only filter for both authentication modes;
this increment has no write-mode flag. Use a **personal API key** with the MCP
Server preset and reviewed project permissions, not a project's public capture
key. OAuth routes to the account's US/EU region. PostHog may charge for underlying
data usage or AI-powered tools even though the MCP connection itself is free.
The [PostHog FAQ](https://posthog.com/docs/model-context-protocol/faq) describes those
limits and the read-only filter. Read-only access still returns project data to
your agent; it is not a zero-cost or no-data-access mode.

An agent's model allowance and every external service's allowance are separate.
Adding a catalog entry does not buy credits or grant permission for unrelated
account actions. No paid endpoint or real account is contacted by the offline
integration tests; actual login, tool availability and billing remain deployment
checks.

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

| Runner      | Configuration                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Remote endpoints use a minimal managed block in private `$CODEX_HOME/config.toml`; local stdio uses `codex mcp add`. Both are inspected with `codex mcp get`. |
| Claude Code | `$CLAUDE_CONFIG_DIR/szpont-mcp.json`, with a `mcpServers` object; `SZPONT_CLAUDE_MCP_CONFIG` overrides this path                                              |
| OpenCode    | `$SZPONT_OPENCODE_HOME/szpont-mcp.json`, with an `mcp` object; `SZPONT_OPENCODE_CONFIG` overrides this path                                                   |

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

The **0.11.0 image includes this command and GitHub CLI**. After taking a verified
pre-upgrade snapshot, stop the engine and pull the selected release:

```sh
export SZPONT_IMAGE=ghcr.io/dalkedev/szpont-engine:0.11.0
docker compose stop engine
docker compose pull engine
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
this menu. The optional Playwright package and browser remain host-provisioned.
The image built from this version includes the locked API-key bridge. Host
installations still install that optional package explicitly. For API-key mode
in Docker, provision a separate private, read-only credential bind mount in your
own Compose override. The file and its parent must have the correct ownership
for the container's service user, UID/GID `1000:1000`, and retain their private
permissions. Supply the **container path** to `--credential-file`; a host-only
path is not accessible there. Keep this mount separate from source and the
managed state, workspace and authentication volumes. The supplied Compose file
does not import a host credential directory automatically.

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
For the four hosted services, status inspects local configuration only; it does
not authenticate with the service or perform a paid availability probe.

Removal deletes only matching engine-managed MCP configuration and its generated
workspace instructions. It preserves entries changed independently, existing
browser profiles, GitHub credentials and accounts. To revoke access, also sign
out through the relevant CLI or remove the application's authorization on the
service itself. API credential files and externally installed optional packages
are preserved. Inspect any partial external actions before resuming a task.
