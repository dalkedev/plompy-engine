# OpenAI Docs

This integration connects to the public official developer-documentation MCP server. It is useful for implementation questions and API documentation, not finding companies or email contacts.

## Set up

```sh
docker compose exec -T local \
  node scripts/integrations.mjs add openai-docs --mode local \
  --tools search_openai_docs,fetch_openai_doc
```

The catalog uses `https://developers.openai.com/mcp`. No model account is installed in Plompy by this action. Only the explicitly selected documentation tools are exposed.

## Apply the configuration

After adding the integration and any required credential, restart the gateway and reconnect the host client so it discovers the updated tools:

```sh
docker compose restart local
```

Use `local-browser` instead of `local` if the browser service is running. A configuration change does not update an already running gateway automatically.

## Try it

```text
Use the OpenAI documentation tools to find the official guidance relevant
to this API question. Link the page and distinguish documentation from
your own inference.
```

## Authentication, cost and limits

This documentation endpoint does not use your model API key. Availability and rate limits remain the provider's responsibility. Your host model may still incur usage when it processes the results.

Run an explicit discovery check and a small documentation query to verify the current endpoint and selected tool names. Do not label the integration live-tested solely because its public URL is configured.

## Verification evidence

On 12 November 2026 at 15:31 UTC, the implementation check initialized the real public endpoint and completed `search_openai_docs` with query `API Responses` and limit 1. This used no model account or paid inference. A successful check on that date does not guarantee future service availability.
