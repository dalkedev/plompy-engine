# Find the failing layer

Check container startup, MCP authentication, tool discovery and actual tool execution separately. A running PID or a successful browser request is not proof of the whole flow.

## Connection refused

Run these on the Docker host from the kit directory:

```sh
docker compose ps
docker compose port local 7331
```

Use `local-browser` if that is your selected service. The second command should print a `127.0.0.1` address. Use that host port in your MCP URL. See the [host connection check](quickstart.md#check-the-connection-from-your-host) to test it over HTTP. A client inside another container or on another machine has its own loopback interface.

## Port already in use

Core and browser share the same published port and volumes. Stop the variant you are switching away from. In the 0.13.1 kit, select a free port from `1024` to `65535` and add or update `PLOMPY_LOCAL_HOST_PORT=17331` (using your chosen number) in the Compose project's `.env` file. Start the service using the existing project name, run `sh check-local-host.sh local`, and regenerate the client configuration for the printed URL. The 0.13.0 and 1.0.0-alpha.1 kits require port `7331`. See [maintenance](maintenance.md) for upgrading an existing kit.

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
