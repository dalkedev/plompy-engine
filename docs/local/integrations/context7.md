# Context7

Context7 supplies library documentation to an agent. It is a hosted documentation service, not a general company-search integration.

## Set up

```sh
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs add context7 --mode local \
  --tools resolve-library-id,query-docs
```

The configured public HTTPS endpoint is `https://mcp.context7.com/mcp`. Use only authentication modes actually supported by the local adapter. A provider's native client OAuth flow is not automatically supported by the gateway.

## Try it

```text
Resolve the library used by this project, then query its documentation
for the API I need. State the library/version and cite the result.
```

## Costs and diagnostics

Provider limits and account requirements may change. Configure a supported credential only if your chosen service access requires it. Run a deliberate live test to establish current access; configuration alone proves no entitlement or reachability.

The selected tool names are checked during discovery. If a vendor changes its catalog, inspect and review the new names instead of adding a wildcard.
