# Connect OpenCode

Plompy Local is a remote MCP server from the client's point of view, even when its HTTP endpoint is on your own laptop.

## Select the correct schema

```sh
opencode --version
```

OpenCode V1 places entries directly under `mcp` and uses `enabled`. V2 places them under `mcp.servers` and uses `disabled`. Do not combine these schemas. The existing Discord runner is independently pinned to OpenCode `1.19.5`; that does not upgrade your host client.

Generate the matching fragment:

```sh
docker compose exec -T local \
  node scripts/integrations.mjs opencode --client-version v1 --mode local
```

## V1 example

```json
{
  "mcp": {
    "plompy": {
      "type": "remote",
      "url": "http://127.0.0.1:7331/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:PLOMPY_LOCAL_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

## V2 example

```json
{
  "mcp": {
    "servers": {
      "plompy": {
        "type": "remote",
        "url": "http://127.0.0.1:7331/mcp",
        "oauth": false,
        "headers": {
          "Authorization": "Bearer {env:PLOMPY_LOCAL_TOKEN}"
        }
      }
    }
  }
}
```

These examples contain no real token. Give `PLOMPY_LOCAL_TOKEN` to the OpenCode process through a private shell session or secret manager. Never paste the token into a repository, URL, issue, screenshot or shared transcript. See [Credentials](credentials.md) for the private container-to-host handoff.

## Hand the token to your host client

In a private host terminal, with shell tracing disabled, capture the token into
the environment without printing it:

```sh
export PLOMPY_LOCAL_TOKEN="$(docker compose exec -T local cat /var/lib/plompy-local/secrets/access-token)"
opencode
```

Use `local-browser` instead of `local` if that is the running service. Do not run
this with `set -x` or copy the resulting environment into diagnostics. Close the
session or `unset PLOMPY_LOCAL_TOKEN` when finished. The command contains no secret
literal; the value remains a secret in the host process environment. Other code
running with the same host account may be able to inspect that environment.

## Preserve your existing configuration

For a new research project, save the matching JSON example as `opencode.json` in that project directory, then run `opencode` from that directory. Keep the starter kit in its own directory and capture the token there before changing into the research project. For an existing project or user-level setup, merge the fragment into its current OpenCode configuration. Preserve other servers, providers and permission rules. The generator prints a fragment by default. An explicit file update must show the change, preserve unrelated fields and create a backup. JSONC comments require a JSONC-aware edit; do not overwrite a commented file with a plain JSON parser.

## Verify in two steps

First, use `opencode mcp list`. Then ask OpenCode to call `plompy_status`. The list checks discovery; the tool call checks that the agent can use the connection.

A model-powered call may consume your model allowance. The offline acceptance harness uses synthetic input and does not prove that a paid provider account is working.

## Instructions are separate

The [agent instructions](research.md#agent-instructions) explain how to use sources and save results. They do not establish MCP connectivity. Conversely, adding MCP does not automatically install those instructions in your project.

See the [official OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/) for the current client and version-specific migration guidance.

## Recorded client check

On 12 November 2026, the actual OpenCode `1.19.5` client completed eight MCP calls against Docker in an isolated synthetic research run. It read a fixture search page and three browser-rendered sources, produced two deduplicated company records, exported JSON and CSV, and read the CSV back. The model was a deterministic local fixture, not paid live inference. OpenCode V2 was not run in this acceptance check.
