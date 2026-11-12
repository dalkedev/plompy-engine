# Playwright

The local `browser_read` tool renders public pages in a fresh Chromium context and returns bounded text, links and published contacts. It is a narrow read adapter, not the full runner-facing Playwright MCP catalog.

## Set up

Follow [Browser setup](../browser.md) to build and start `local-browser`. The pinned dependency comes from the existing `packages/playwright` lock. Setting an integration flag in the core image does not install a browser.

## Authentication and cost

No vendor API key is needed. The browser does not import your logged-in profiles or cookies. Rendering consumes local CPU and memory; public websites and your host model still receive the data described in [Security](../security.md).

## Try it

```text
Use browser_read on this public company page. Report its title, the
relevant project facts and any published contact source URLs.
```

## Boundaries

Chromium sandboxing stays enabled. Requests are checked against the public-network policy. There are no generic clicking, form, upload or script-evaluation tools. Sites needing a login, CAPTCHA or unsupported interactions may remain unreadable.

## Connection test

Run the container browser smoke test from the implementation's verification instructions. It must launch a real browser and read a controlled fixture. A successful host browser test alone is not evidence for Docker support. See [Compatibility](../compatibility.md).
