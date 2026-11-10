# Optional Playwright MCP tools

This package is separate from the engine's installation. It pins the official
[`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) server to **0.0.85**
with its committed npm lock. Its upstream dependency pins Playwright to
`1.66.0-alpha-2026-11-09`; this is the dependency shipped by that MCP release,
not an unbounded nightly update.

Install explicitly on the Linux or macOS host, using the same service user:

```sh
npm ci --prefix packages/playwright
node packages/playwright/install-browser.mjs \
  --cache-dir "$SZPONT_BROWSER_DIR/playwright/cache"
```

The second command downloads the pinned Chromium build and FFmpeg into that
private cache. It does not install system packages, invoke sudo, or delete other
browser versions. On Linux, provision the required host libraries separately;
the official [Playwright browser documentation](https://playwright.dev/docs/browsers#install-system-dependencies)
describes those dependencies. A host that cannot run Chromium's sandbox must be
fixed before using this integration. There is no automatic sandbox fallback.

Then use the engine's integrations CLI to configure Playwright for the selected
runner. `scripts/integrations/playwright.mjs` exposes
`preparePlaywright({ config, publicRoot, browserBin?, nodeBin? })` for that CLI.
It returns a provider-neutral stdio definition with an absolute Node command and
launcher path. Configuration does not start a browser or download dependencies.
An optional browser override must be an absolute regular executable that other
users cannot modify; its compatibility remains the operator's responsibility.

The launcher uses headless, isolated browser contexts with Chromium's sandbox
enabled. Each launch gets a separate 0700 artifact directory and a short-lived
0700 OS temporary directory. Temporary browser files are removed when that
launch exits; screenshots and other requested output remain private artifacts.
It does not copy accounts, cookies, profiles, or runner credentials. Browser
file tools are restricted to that launch's output workspace; local file URLs are
blocked by the upstream MCP server. This is not a network allowlist or a complete
security boundary: a browser tool can still access websites and perform actions
within the current owner's authorized task.

The core Docker image does not include this npm installation, Chromium or its
system dependencies. The stdio launcher never runs npm/npx, installs browsers,
connects to a user's existing browser, or opens a public MCP listener.

Run the focused offline tests and the real, synthetic loopback acceptance test:

```sh
npm test --prefix packages/playwright
node packages/playwright/smoke.mjs \
  --cache-dir "$SZPONT_BROWSER_DIR/playwright/cache"
```

Alternatively set `SZPONT_PLAYWRIGHT_SMOKE_CACHE` and run
`npm run smoke --prefix packages/playwright`. The smoke uses real stdio MCP and
the installed browser: navigate, inspect snapshot references, type, click,
assert the changed page, check PNG output and private permissions, reject file
traversal and local-file navigation, and compare two concurrent isolated
contexts. It uses only its own `127.0.0.1` HTML fixture, no model or account, and
cleans its synthetic artifacts afterwards. Missing browser/host prerequisites
fail the smoke; they do not trigger a download.
