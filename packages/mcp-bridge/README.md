# Managed MCP credential bridge

This optional package lets Codex, Claude Code and OpenCode use the same private
API-key file without putting its contents in runner configuration, arguments or
the agent environment. Native OAuth entries do not need this package on a host.

```sh
npm ci --prefix packages/mcp-bridge
npm test --prefix packages/mcp-bridge
```

Use the integrations CLI to configure a service. Create a separate private
credential directory outside source, workspace, state, artifacts, browser and
runner directories. The directory must be owned by the service user with mode
0700, and the token file must be a regular, single-link file with mode 0600. Paths
must be absolute and have no symlink components. A file contains only its API
token, optionally followed by one newline, with a limit of 4096 printable ASCII
bytes. Szpont reads and validates the file; it never rewrites or deletes it.

```sh
npm run integrations -- add perplexity --runner codex --yes \
  --auth api-key --credential-file /private/szpont-credentials/perplexity.txt
```

The bridge uses the pinned official MCP TypeScript SDK and fixed vendor HTTPS
destinations. Perplexity, Firecrawl and PostHog use Bearer authentication; TinyFish
uses `X-API-Key`. PostHog requests always carry `x-posthog-read-only: true`.
There is no arbitrary URL, header, environment-variable or endpoint override.
Redirects, automatic retries and OAuth discovery are disabled for API-key mode.
An uncertain failed call must be checked at the remote service before retrying.

The request/response relay supports tools, resource listing/reading/templates,
prompts and completions when the upstream advertises them. It relays call progress
and cancellation. It does not advertise background resource subscriptions, list
change notifications, sampling, elicitation or experimental MCP tasks. Native
OAuth connections continue to use the runner's own MCP transport and auth flow.

Limits: four simultaneous calls, 2 MiB input frames, 8 MiB per upstream response,
15 seconds for initialization and 180 seconds per call. Successful results redact
the configured token if a server echoes it; error diagnostics do not include
upstream bodies, credentials or private paths. Closing stdin or receiving a
termination signal closes the bridge and cancels outstanding streams without
replaying calls or issuing remote session deletion.

These integrations contact third-party services when an agent actually uses a
tool. Authentication, credits, service terms and permission to perform a task
remain the operator's responsibility. A same-user agent can read files accessible
to that operating-system account: file references reduce accidental exposure,
they do not create a security boundary against that account.

Tests use only synthetic tokens and injected offline MCP responses. They cover
real SDK initialize/list/call/SSE/cancellation/shutdown behavior, fixed destinations,
PostHog read-only enforcement, redaction, concurrency, limits and failed calls.
No test authenticates with or calls a vendor account.
