# Find the failing layer

Check container startup, MCP authentication, tool discovery and actual tool execution separately. A running PID or a successful browser request is not proof of the whole flow.

## Connection refused

Check `docker compose ps` and confirm the selected service is running. Core and browser services share port `7331`; do not start both at once. Confirm that the container listener is reachable through the loopback publication.

The host client URL is `http://127.0.0.1:7331/mcp`. Inside a different container, `127.0.0.1` means that other container. This quickstart places the MCP client on the host.

## Unauthorized or forbidden

Verify that the host client process has the correct token reference and that it was restarted after an environment change. Do not paste tokens into logs while diagnosing it. Check the configured Host/Origin values if you deliberately changed the endpoint. A normal webpage is not an approved MCP client.

## Unknown configuration field

Check `opencode --version`. V1 uses `mcp` entries and `enabled`; V2 uses `mcp.servers` and `disabled`. Regenerate the fragment for the installed client. Do not upgrade the engine's separately pinned runner while fixing a host-client configuration.

## Connected, but the tool is missing

Inspect local status. An integration must be enabled, supported by the image, authenticated when required and allowed by its tool policy. Restart the gateway after config changes and reconnect the client. A newly added vendor tool is not automatically permitted.

## Key exists, but the provider rejects it

Key presence only proves local configuration. Check the provider account, API product, scope and billing status yourself, then run one explicit live test. A consumer subscription may not include API access. Never repeatedly retry uncertain paid calls.

## Rate limit or timeout

Read the integration-specific error. Reduce batch size and wait according to the provider's guidance. Other integrations should remain usable. Do not describe incomplete results as a successful 30-company export.

## Browser unavailable

Use the browser image and profile, not just the core image with a Playwright configuration entry. Verify the sandbox diagnostic for the host platform. The [browser guide](browser.md#if-the-sandbox-cannot-start) explains the optional Linux AppArmor profile for actual user-namespace denials. Do not disable sandboxing to silence the error.

## URL denied

Private network addresses, local endpoints, metadata services and unsafe redirects are blocked. A publicly named domain resolving to a private address is still private. Test-only fixture exceptions are not a general intranet feature.

## Export rejected

Use a flat basename with the correct extension. Choose a new filename if a different artifact already exists. Keep rows and content within tool limits. Inspect the result with `artifacts_read` and verify the reported hash.

## Where to report a problem

Include the release version or source revision, image tag/digest, operating system, Docker and host client versions, the step that failed and a redacted error. Exclude tokens, private config files, cookies, company drafts and account data unless you deliberately intend to share them.
