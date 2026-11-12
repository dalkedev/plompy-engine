# One conversation. Selected tools.

The local mode follows a single agent loop:

```text
You -> Codex / Claude Code / OpenCode / another MCP client
         -> MCP over loopback HTTP
              -> Plompy Local in Docker
                   -> enabled read tools
                   -> optional external integrations
                   -> private artifact volume
         <- tool results and source URLs
You <- response, evidence and saved files
```

## Your client decides what to do

The host client owns the conversation, model selection, planning and tool choice. Its own permissions still apply. Adding Plompy does not remove your client's existing tools or isolate its shell.

## Plompy exposes a small tool surface

The gateway validates requests, authenticates the client, exposes only selected tools and enforces bounded calls. It does not offer a generic shell, browser script executor or arbitrary integration invocation tool.

The standard MCP SDK handles initialization, discovery and calls over Streamable HTTP at `/mcp`. The gateway has no Discord connection and does not load the engine's runner authentication.

## Integrations remain separate

The existing catalog identifies supported services. Local mode adds an explicit research policy on top: a configured service and an allowed tool name are both required. A missing or failing integration is reported separately; it does not make unrelated local tools unavailable.

API-key services reuse the fixed vendor definitions and private credential handling from Plompy's existing MCP bridge. GitHub uses a dedicated read adapter for `gh`. It is not treated as an existing MCP server.

## Files survive container replacement

Configuration, secrets and artifacts use separate named volumes. A rebuilt image does not remove them. Do not run Compose with volume deletion unless you intend to erase that data. See [Backups and updates](maintenance.md).

## Where code lives

- Engine and canonical Markdown: [dalkedev/plompy-engine](https://github.com/dalkedev/plompy-engine).
- Local gateway: `packages/local-mcp/`.
- CLI: `scripts/local-integrations.mjs`, reached through the existing integrations command.
- Local containers: `Dockerfile.local` and `compose.local.yaml`.
- Website: the existing static Plompy site, built from HTML, CSS and JavaScript. Documentation pages are generated from the engine's `docs/local/` Markdown.

A copy of documentation in a browser is not a connection to a local gateway. The website never requests your integration keys or automatically contacts localhost.
