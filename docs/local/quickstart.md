# Run locally with Docker

Build the Local MCP preview from the repository's `main` branch. These commands build from source; they do not pull a published Plompy Local image. Do not use the `v0.12.0` release tag for this quickstart.

## Before you start

Install Git and Docker with Compose. Choose a host MCP client such as Codex, Claude Code or OpenCode, with its usual model access configured. The Plompy container does not need model credentials or a Discord token. See [Requirements](requirements.md).

Clone the source into a new directory, then build the core gateway:

```sh
git clone --depth 1 https://github.com/dalkedev/plompy-engine.git
cd plompy-engine
docker compose -f compose.local.yaml build local
```

## Initialize the private volumes

```sh
docker compose -f compose.local.yaml run --rm local \
  node scripts/integrations.mjs init --mode local
```

Initialization creates a private configuration and local access token. It preserves existing configuration. Secrets are stored separately from artifacts.

## Start the gateway

```sh
docker compose -f compose.local.yaml up -d local
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs status --mode local
```

The default endpoint is `http://127.0.0.1:7331/mcp`. Docker publishes it on host loopback only. The process listens on the container interface so the published port is reachable. A normal browser visit is not a connection test: the endpoint requires MCP and a bearer token.

## Check the local protocol

```sh
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs test --mode local
```

This initializes MCP and calls local status. It deliberately avoids remote tool discovery and does not contact vendors or a model.

## Connect your agent

The gateway is client-neutral. Choose the configuration for your installed client:

- [Codex](codex.md): Streamable HTTP with a bearer-token environment reference.
- [Claude Code](claude-code.md): HTTP MCP with an environment-based authorization header.
- [OpenCode](opencode.md): explicit V1 or V2 configuration.
- [Other MCP clients](other-clients.md): connection requirements and compatibility limits.

For local inference, see [Ollama with your agent](ollama.md). Ollama provides the model; your agent remains the MCP client.

Keep the local token in a private environment, separate from the project. Each client guide shows its configuration format. Model login stays in your client; Plompy does not import it.

## Check the client connection

Use your client's MCP connection check before starting a model task. Then ask it:

```text
Use the Plompy status tool. Tell me which integrations are enabled,
which still need credentials, and which have actually been live-tested.
Do not search the web yet.
```

A configured entry, a connected server and a completed tool call are separate checks. A model-powered tool call may consume your client model allowance.

## Add one search integration

For a company-research task, enable one search provider. [Firecrawl](integrations/firecrawl.md) supports a limited keyless path and a separately configured API-key path. [Perplexity](integrations/perplexity.md) requires your own API access. Review their costs before running an external test.

Add the [browser profile](browser.md) only if the pages you need require a rendered browser. Basic public page fetching is available in the core profile.

## Try a bounded task

```text
Find up to 3 Polish companies building mobile apps. Use public company
websites to support each match. For each, save its name, website, public
business email if explicitly published, the exact source URL, and a short
email draft proposing a university project. Save JSON and CSV through
Plompy's artifact tools. Do not send messages or invent missing contacts.
```

Inspect the sources and drafts yourself. Expand to 30 companies once the small task produces useful evidence. See [the complete research example](research.md).
