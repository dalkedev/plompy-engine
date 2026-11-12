# Connect only what you need

The default research profile exposes basic public page reads and local artifacts. Add one search service if you need discovery; add the browser profile if pages need rendering.

A configured key is not proof that an account works. Status distinguishes configuration from tool discovery and actual successful calls. Live tests that contact an external service are opt-in and may consume its allowance.

## Local-mode matrix

| Integration | Local-mode role | Authentication | Container requirement | Limit |
| --- | --- | --- | --- | --- |
| [Public web](integrations/web.md) | Read public HTTP(S) pages | None | Core image | No private network or authenticated browser session |
| [Playwright](integrations/playwright.md) | Render a page and extract text/links | None | Browser profile | Read-only, sandbox enabled |
| [GitHub](integrations/github.md) | Selected repository reads | Dedicated GitHub token required | Core `gh` adapter | No arbitrary commands or writes |
| [Firecrawl](integrations/firecrawl.md) | Search and scraping | Keyless limits or own API key | Core plus network | Explicit tool allowlist |
| [Perplexity](integrations/perplexity.md) | Search and research | Own API key | Core plus network | API billing separate from consumer subscription |
| [OpenAI Docs](integrations/openai-docs.md) | Official documentation | Public endpoint | Core plus network | Documentation, not company search |
| [Context7](integrations/context7.md) | Library documentation | Endpoint-dependent | Core plus network | Vendor rate limits |
| [PostHog](integrations/posthog.md) | Product analytics reads | Scoped personal API key | Core plus network | Existing project access required |
| [Custom MCP](integrations/custom.md) | Existing runner integration | Runner-specific | Not exposed by local research profile | Tool names and annotations cannot prove read-only behavior |
| [TinyFish](integrations/tinyfish.md) | Existing runner integration | Runner-native auth | Not exposed by local research profile | Autonomous actions need a separate policy |
| [Camoufox](integrations/camoufox.md) | Existing host browser integration | Host setup | Not supported in local Docker profile | Use Playwright for this local flow |

## Configuration versus availability

- **Registered:** the integration exists in the catalog.
- **Configured:** local settings are present.
- **Needs authentication:** credentials are missing or rejected.
- **Available:** the adapter can expose the selected tools.
- **Live-tested:** a real external call succeeded in the reported test scope.
- **Unsupported:** this profile cannot run the integration.

The exact status response contains the available evidence. Do not convert “configured” into “live-tested” in reports or UI.

## Explicit tools

Remote tool names are selected by the operator and intersected with the research policy. A provider adding new tools does not silently grant them to the agent. The gateway does not expose an unrestricted `execute` or `invoke` escape hatch.

## Changing integrations

Use the same integrations CLI with `--mode local`. The existing `--runner` paths remain for the Discord engine. Restart the gateway after changing its configuration so discovery reflects the new selection.

An explicit remote discovery diagnostic initializes MCP and lists permitted tools; it does not call a search or scrape tool:

```sh
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs test firecrawl --mode local --live
```

The `--live` flag permits contacting that configured service. A subsequent authorized tool call is required before claiming the task or integration is live-tested.

```sh
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs status --mode local
```
