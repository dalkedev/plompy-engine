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

Ubuntu 24.04 and similar hosts may restrict unprivileged user namespaces through
AppArmor. A confirmed `host-sandbox-unavailable` smoke failure needs administrator
review. After installing the pinned browser, generate an exact-path policy:

```sh
node packages/playwright/apparmor-profile.mjs \
  --cache-dir "$SZPONT_BROWSER_DIR/playwright/cache" > /private/chromium.apparmor
```

The generator only prints a policy; it changes no file, profile or kernel setting.
An administrator must inspect it, install it as a root-owned file under
`/etc/apparmor.d/`, and load it with `apparmor_parser`. It grants `userns` only to
the exact provisioned Chromium executable. It is an allow profile for the
browser's own sandbox, not a full AppArmor confinement policy. Browser versions
have distinct paths: review and regenerate the policy after a browser update.
The generator rejects pattern characters and non-ASCII paths. It never uses a
wildcard profile, disables a kernel restriction, or changes Chromium's sandbox
flags. See the [Chromium explanation](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)
and [Ubuntu documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).

Then use the engine's integrations CLI to configure Playwright for the selected
runner. `scripts/integrations/playwright.mjs` exposes
`preparePlaywright({ config, publicRoot, browserBin?, nodeBin? })` for that CLI.
It returns a provider-neutral stdio definition with an absolute Node command and
launcher path. Configuration does not start a browser or download dependencies.
An optional browser override must be an absolute regular executable that other
users cannot modify; its compatibility remains the operator's responsibility.

Codex MCP tool approval is separate from connecting the server. The default
configuration and `--yes` do not grant unattended browser-tool approval. An
operator who wants the built-in Playwright server to run without interactive
tool prompts can explicitly register a new entry with:

```sh
npm run integrations -- add playwright --runner codex --yes --tool-approval approve
```

Only that server receives `default_tools_approval_mode = "approve"`; global
approvals, other tools, task authorization and managed security controls remain
separate. Browser actions can navigate and submit real forms. The alternative
`--tool-approval prompt` requires approval prompts, which unattended sessions
cannot answer. These options apply only to the built-in Codex Playwright entry.
Existing entries, per-tool overrides and other operator restrictions are preserved
as conflicts. Follow the [migration and validation guide](../../docs/integrations.md#explicit-codex-tool-approval-for-unattended-playwright)
before changing an already configured entry. Codex's `mcp get` JSON alone is not
proof of the effective approval setting.

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
