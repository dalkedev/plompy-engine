# Plompy Local @VERSION@

Prebuilt local tools for Codex, Claude Code, OpenCode and compatible MCP clients.
Docker runs the tools; your host client runs the conversation and chosen model.
No Discord account, model login or source build is required inside the container.

Requirements: Docker with Compose and a configured host MCP client. Both images
support Linux amd64 and arm64, including Docker Desktop on Apple Silicon.

## Start

From the directory containing this file and `compose.yaml`:

```sh
docker compose pull local
docker compose run --rm -T local node scripts/integrations.mjs init --mode local
docker compose up -d --wait local
docker compose exec -T local node scripts/integrations.mjs test --mode local
sh check-local-host.sh local
```

The authenticated endpoint is `http://127.0.0.1:7331/mcp`. Only host loopback is
published. Private configuration, secrets and artifacts persist in named volumes.
The container check initializes MCP and calls `plompy_status`. The host check uses `curl`
to verify the authenticated Docker publication and prints the URL to use in the client.
Both checks run without a model or external provider account.

If port `7331` is occupied, set `PLOMPY_LOCAL_HOST_PORT=17331` (or another free port
from `1024` to `65535`) in this Compose project's `.env` file before starting it.
For an existing installation, keep its project name and apply the changed port with
`docker compose up -d --force-recreate local`. The access token and results remain
in their volumes. Generate fresh client fragments for the new URL.

## Connect OpenCode

Check `opencode --version`. OpenCode 1.19.5 was exercised as an actual client;
V2 uses a different configuration shape. Print the matching fragment:

```sh
docker compose exec -T local node scripts/integrations.mjs opencode --client-version v1 --mode local
```

Merge the generated fragment into your current `opencode.json`. Use `--client-version v2`
if your client uses that schema. The included example files use the default port.
Preserve existing model, provider, MCP and permission settings.
In a private terminal with shell tracing disabled, give the token to the client
without displaying or storing it in the project:

```sh
export PLOMPY_LOCAL_TOKEN="$(docker compose exec -T local cat /var/lib/plompy-local/secrets/access-token)"
opencode mcp list
opencode
```

Ask OpenCode: "Call plompy_status and report available tools. Do not search yet."
To save a first result using built-in tools, ask it to use `web_fetch` on
`https://plompy.dev/docs/`, export the title and returned URL to
`plompy-first-result.json`, and read the saved file back.
Then configure one search integration if the task requires discovery. Your
client's model access and each integration's API allowance remain separate.
After adding an integration, restart `local` and reconnect your client.

Codex and Claude Code examples are also included. Their CLI exports are:

```sh
docker compose exec -T local node scripts/integrations.mjs codex --mode local
docker compose exec -T local node scripts/integrations.mjs claude-code --mode local
```

`AGENTS.md` contains optional research instructions. It does not establish an MCP
connection. Keep task data and credentials outside the public source repository.
The gateway can save drafts but has no email sending tool.

## Add the browser

The core image fetches public pages. Switch to the larger browser image for
JavaScript-rendered content; do not run both services on the same port:

```sh
docker compose stop local
docker compose --profile browser pull local-browser
docker compose --profile browser run --rm -T local-browser node scripts/integrations.mjs add playwright --mode local
docker compose --profile browser up -d local-browser
docker compose exec -T local-browser node scripts/integrations.mjs test --mode local
sh check-local-host.sh local-browser --profile browser
```

Use `local-browser` in subsequent exec/token commands. Chromium's sandbox stays
enabled. The read tool does not expose arbitrary scripts, clicks or form submits.

On a Linux host that specifically denies Chromium user namespaces through
AppArmor, install the included scoped profile instead of disabling the sandbox:

```sh
sudo install -m 0644 docker-local-apparmor /etc/apparmor.d/plompy-local-container
sudo apparmor_parser -r -W /etc/apparmor.d/plompy-local-container
docker compose -f compose.yaml -f compose.apparmor.yaml --profile browser up -d local-browser
```

Use both `-f` arguments for later operations on that installation. Docker Desktop
normally does not require this host-side override.

## Save, stop and upgrade

Artifacts are under `/var/lib/plompy-local/artifacts` in the running container.
Copy a selected export without exposing credentials:

```sh
docker compose cp local:/var/lib/plompy-local/artifacts/results.csv ./results.csv
docker compose down
```

`down` preserves named volumes. `down --volumes` deletes configuration, credentials
and saved results; use it only for an intentional uninstall. Keep the project
name `plompy-local` and volume names when upgrading, and back up private volumes.
Images are pinned to @VERSION@. Rollback uses a previous compatible image and
matching private backup; it does not undo external provider calls.

Full guides: https://plompy.dev/docs/quickstart/ and https://plompy.dev/docs/ollama/.
Ollama is an optional host-model provider; no model is bundled in these images.
