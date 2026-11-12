# Firecrawl

Firecrawl can discover pages and extract their content. It is an external service: queries and requested URLs leave your computer. The gateway supports an explicitly selected tool subset.

## Limited keyless setup

```sh
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs add firecrawl --mode local \
  --auth keyless --tools firecrawl_search,firecrawl_scrape
```

Keyless access is subject to the vendor's current restrictions and availability. It is not a promise of an unlimited free plan.

## API-key setup

Choose API-key mode and provide a dedicated key through the private credential workflow. Do not type the key in the command arguments or save it in your client project configuration. The local gateway does not perform Firecrawl OAuth login.

## Try it

```text
Use the configured Firecrawl search tool to find up to 3 Polish mobile
app development companies. Read official pages and retain their URLs.
Use web_fetch or the allowed scrape tool for the evidence.
```

## Read-only argument surface

The gateway limits `firecrawl_search` to a query and bounded result count. `firecrawl_scrape` accepts a public URL, optional main-content extraction and only Markdown, HTML or links as output formats. `firecrawl_map` accepts a URL, optional search text and a bounded result count. Browser actions, arbitrary JavaScript and extra upstream arguments are rejected.

## Costs and limits

Your account, credits, rate limits and the vendor's terms apply. Search and scraping can consume credits. No extra provider calls are made merely by reading local configuration status.

Discovery and a real tool call are different checks. Run an explicit live diagnostic, then one small search you approve. Never treat a stored key as proof of a successful search.

The gateway exposes only configured read tools that pass its research policy. It does not automatically enable new crawl, agent or mutation tools when the vendor adds them.

See [Firecrawl MCP documentation](https://docs.firecrawl.dev/mcp-server) for provider requirements.
