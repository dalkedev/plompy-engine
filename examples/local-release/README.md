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
docker compose up -d local
docker compose exec -T local node scripts/integrations.mjs test --mode local
```

The authenticated endpoint is `http://127.0.0.1:7331/mcp`. Only host loopback is
published. Private configuration, secrets and artifacts persist in named volumes.
The default diagnostic calls no model or external provider.

## Connect OpenCode

Check `opencode --version`. OpenCode 1.19.5 was exercised as an actual client;
V2 uses a different configuration shape. Print the matching fragment:

```sh
docker compose exec -T local node scripts/integrations.mjs opencode --client-version v1 --mode local
```

Merge `opencode-v1.json` into your current `opencode.json` (or use the V2 file for
that client). Preserve existing model, provider, MCP and permission settings.
These files are examples, not a command to overwrite an existing configuration.
In a private terminal with shell tracing disabled, give the token to the client
without displaying or storing it in the project:

```sh
export PLOMPY_LOCAL_TOKEN="$(docker compose exec -T local cat /var/lib/plompy-local/secrets/access-token)"
opencode mcp list
opencode
```

Ask OpenCode: "Call plompy_status and report available tools. Do not search yet."
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
