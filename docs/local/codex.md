# Connect Codex

Run the [Docker quickstart](quickstart.md) first. Codex stays on your host and uses its own model login. Plompy provides selected tools over the local HTTP endpoint.

## Add the MCP server

The installed Codex CLI `0.159.2` supports this command:

```sh
codex mcp add plompy --url http://127.0.0.1:7331/mcp \
  --bearer-token-env-var PLOMPY_LOCAL_TOKEN
```

The command registers an environment variable name, not the secret itself. If a server called `plompy` already exists, inspect it before replacing it. Preserve unrelated MCP entries.

## Or merge a TOML entry

Generate the fragment from the running container:

```sh
docker compose exec -T local \
  node scripts/integrations.mjs --mode local codex
```

The output is:

```toml
[mcp_servers.plompy]
url = "http://127.0.0.1:7331/mcp"
bearer_token_env_var = "PLOMPY_LOCAL_TOKEN"
```

Merge it into your private Codex configuration. The generator is print-only; it does not replace a host file or your other servers.

## Provide the token privately

In a private terminal with shell tracing disabled:

```sh
export PLOMPY_LOCAL_TOKEN="$(docker compose exec -T local cat /var/lib/plompy-local/secrets/access-token)"
codex
```

Use `local-browser` if that is the running service. The variable must exist in the process that launches Codex. A separately launched desktop app does not automatically inherit this terminal environment. Do not paste the token into project files or screenshots. Read [Credentials](credentials.md) for storage and cleanup.

## Verify the connection

Use `codex mcp list` to inspect registration. Then start a Codex session and ask it to call `plompy_status`. Registration alone does not prove a completed MCP call or a working model account.

Codex's own permissions and tools remain in effect. Adding the Plompy research profile does not restrict Codex's separate shell, browser or other integrations. See [verification results](compatibility.md) for the tested boundary.

## Recorded client check

On 12 November 2026, the actual Codex `0.159.2` CLI parsed the generated configuration and completed `plompy_status` against Docker. The test used an isolated client directory and a deterministic local Responses mock, which received two model requests. It asserted a completed MCP tool event. This verifies the client-to-tool path, not a paid model account or research reasoning quality.
