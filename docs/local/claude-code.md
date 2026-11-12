# Connect Claude Code

Run the [Docker quickstart](quickstart.md) first. Claude Code keeps its own model login on your host. Plompy adds selected tools through an HTTP MCP connection.

## Generate a configuration fragment

```sh
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs --mode local claude-code
```

The output is:

```json
{
  "mcpServers": {
    "plompy": {
      "type": "http",
      "url": "http://127.0.0.1:7331/mcp",
      "headers": {
        "Authorization": "Bearer ${PLOMPY_LOCAL_TOKEN}"
      }
    }
  }
}
```

Claude Code expands the environment variable in the header. Preserve the literal `${PLOMPY_LOCAL_TOKEN}` reference when saving JSON; do not expand it into a real token in a shell-generated file. Merge the entry with your existing MCP configuration rather than overwriting it. The generator is print-only.

## Register with the CLI

The installed Claude Code CLI `2.1.197` supports HTTP MCP. Use single quotes around the header so your shell preserves the variable reference:

```sh
claude mcp add --transport http plompy http://127.0.0.1:7331/mcp \
  --header 'Authorization: Bearer ${PLOMPY_LOCAL_TOKEN}'
```

Choose the configuration scope appropriate to your project. Inspect an existing `plompy` entry before replacing it. The [official Claude Code MCP guide](https://code.claude.com/docs/en/mcp) explains scopes, environment expansion and client-side permission prompts.

## Provide the token privately

In a private terminal with shell tracing disabled:

```sh
export PLOMPY_LOCAL_TOKEN="$(docker compose -f compose.local.yaml exec -T local cat /var/lib/plompy-local/secrets/access-token)"
claude
```

Use `local-browser` if that is the running service. Keep the environment available to the Claude process, then unset it or close the terminal when finished. See [Credentials](credentials.md). A GUI client started elsewhere may not inherit this environment.

## Verify before research

Use `claude mcp list` to inspect server connectivity. In an interactive Claude Code session, `/mcp` shows connected servers and tools. Ask Claude to call `plompy_status` before requesting research.

A server connection check does not prove model access, an integration's API key or a completed research result. Claude Code's separate tools and permission settings are unchanged. See [verification results](compatibility.md).

## Recorded client check

On 12 November 2026, Claude Code `2.1.197` reported Connected after an authenticated MCP health check against the Docker gateway. The test used isolated home/configuration and a private token environment. No Claude agent or model turn was run, so this check does not establish model-powered tool execution.
