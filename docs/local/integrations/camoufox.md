# Camoufox

Camoufox remains available through Plompy's existing Linux host integration. It needs its separately provisioned Python environment, browser and private display.

## Local Docker status

Camoufox is not supported in the new local research container. This documentation does not present it as a tested Docker feature. Use the [Playwright browser profile](../browser.md) for the container workflow.

## Existing host setup

Follow the [existing browser and integrations documentation](https://github.com/dalkedev/plompy-engine/blob/main/docs/integrations.md). That setup is distinct from connecting a host MCP client to Plompy Local.

Do not copy private cookies or profile directories from a running Discord deployment into the new gateway. A host configuration or package import passing does not demonstrate an operational browser in Docker.

## Authentication and costs

The host browser uses the operator's deliberately provisioned session and permissions. Websites and any services used have their own access conditions. The local gateway does not start an authorization flow or charge a Camoufox fee.

## Testing

The existing Python offline suite checks its code paths. A real browser test must be performed separately in the actual supported host environment. No local Docker Camoufox acceptance is claimed.
