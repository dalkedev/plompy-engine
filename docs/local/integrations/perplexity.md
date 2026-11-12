# Perplexity

The Perplexity integration provides hosted search and research tools. Local mode uses a dedicated API key and the fixed vendor MCP endpoint. The existing runner-native OAuth path remains separate.

## Set up

```sh
docker compose exec -T local \
  node scripts/integrations.mjs add perplexity --mode local \
  --auth api-key --tools perplexity_search
```

Add the key through the private credential command. Restart the gateway and reconnect the client. Missing credentials should produce an authentication-required status for this integration, without breaking other tools.

## Apply the configuration

After adding the integration and any required credential, restart the gateway and reconnect the host client so it discovers the updated tools:

```sh
docker compose restart local
```

Use `local-browser` instead of `local` if the browser service is running. A configuration change does not update an already running gateway automatically.

## Try it

```text
Search for Polish companies that publish mobile application case studies.
Return candidate official website URLs. Then read those sources before
claiming that a company matches my project.
```

## Costs

Perplexity API usage belongs to your API organization and allowance. A consumer subscription does not establish API access. Search or research calls may be billed. Start with a small query and check the provider's current pricing.

## Evidence and limitations

Search output helps discover candidates; it does not replace reading the cited company source. Keep the exact contact page for an email address. Report rate limits, authentication failures and incomplete batches honestly.

A live tool test is opt-in. No real Perplexity account success is implied by the offline tests. See [provider MCP documentation](https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server).
