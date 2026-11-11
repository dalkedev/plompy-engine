# Plompy Browser

An optional Camoufox browser bridge exposed through the official Python MCP SDK over local **stdio**. It launches no HTTP listener. The service account uses one persistent browser profile, with one complete Camoufox-generated identity saved alongside it. Manual login and automated jobs use the same factory, profile, binary and identity.

Python **3.12–3.14** is supported; the target is Ubuntu 26.04 x86_64 with Python 3.14. `camoufox==0.5.9` and `mcp==2.3.0` are pinned. The current official SDK calls its former `FastMCP` class `MCPServer`; the decorator-based tools and stdio transport remain the same API style. This package uses that current SDK, rather than the obsolete import path.

## Installation

Provision dependencies into the root-owned release virtual environment. `uv.lock`, `requirements.lock` and `requirements-dev.lock` contain exact transitive versions; the exported requirements include hashes. Runtime installation:

```sh
python3 -m venv packages/browser/.venv
packages/browser/.venv/bin/pip install --require-hashes -r packages/browser/requirements.lock
packages/browser/.venv/bin/pip install --no-deps packages/browser
```

The build backend is separately pinned to `hatchling==1.33.0`. For an entirely preinstalled build environment, install `requirements-dev.lock`, then add `--no-build-isolation` to the final package installation. CI can also use `uv sync --frozen --python 3.14` followed by `uv run --frozen pytest`.

The browser archive is a separate, approximately **1.3 GB** download. `browser-build.json` records the exact official Linux x86_64 release URL, version, size and GitHub-published SHA-256. The Python package's paired browser is **158.0.1-beta.41**. Provision it as root using the separate fetch helper, which verifies size and the pinned SHA-256 before extraction and installs a new directory atomically:

```sh
/opt/plompy/current/packages/browser/.venv/bin/python -m plompy_browser.fetch \
  --manifest /opt/plompy/current/packages/browser/browser-build.json \
  --destination /opt/plompy/browser/158.0.1-beta.41
```

An optional `--archive /opt/plompy/downloads/camoufox-158.0.1-beta.41-lin.x86_64.zip` reuses a predownloaded archive and performs the same verification. The helper refuses to overwrite an existing destination. It writes `.plompy-build.json` with archive verification evidence. The executable is `/opt/plompy/browser/158.0.1-beta.41/camoufox-bin`; keep its directory root-owned and readable/executable by `plompy`. No runtime tool installs or updates the browser.

The deployment bootstrap owns Linux graphics/font libraries and Xvfb. Run MCP and manual login with the same Xvfb screen geometry and inherited `DISPLAY`/`XAUTHORITY`. This package always launches a **headed** browser (`headless=False`); it does not create another Xvfb server or silently switch rendering modes. Root-owned source, virtual environment and browser binaries are separate from writable account state.

## Runtime contract

```text
command: /opt/plompy/current/packages/browser/.venv/bin/python
args: ["-m", "plompy_browser"]
user: plompy

CAMOUFOX_EXECUTABLE_PATH=/opt/plompy/browser/158.0.1-beta.41/camoufox-bin
PLOMPY_BROWSER_PROFILE=/var/lib/plompy/browser
PLOMPY_BROWSER_ARTIFACTS=/var/lib/plompy/artifacts/browser
XDG_CACHE_HOME=/var/lib/plompy/state/cache
```

`CAMOUFOX_EXECUTABLE_PATH` is required and must name an existing executable. This prevents launch from silently downloading another binary. Both state directories are private (`0700`); screenshots and identity files are `0600`. Do not commit or print the profile, cookies, fingerprint file, screenshots or login information. Screenshots and page snapshots may contain the owner's private data. Retention/backups belong to deployment policy.

On the first actual launch, Camoufox generates a coherent Linux identity using its own generator and launch configuration. The bridge saves the resulting `CAMOU_CONFIG_*`, `CAMOU_PREFS_*`, Firefox preferences and font configuration reference in `.plompy-identity.json`. It reuses these exact options on later launches; it never assembles a random user-agent string. Only a small allowlist of display, home, locale and cache environment variables reaches the browser child process. Codex/API credentials are not inherited by that child or saved with the identity.

The identity also records the browser executable's SHA-256 and the Camoufox package version. Changed binaries, malformed saved identities and missing saved font configuration fail visibly. A browser upgrade requires explicit profile/identity maintenance; it does not silently rotate the logged-in account's fingerprint. The adjacent `.plompy.lock` and compatibility `.szpont.lock` use nonblocking process locks, so old and new processes cannot open the same profile concurrently. Existing `.szpont-identity.json` files are reused; see the [migration guide](../../docs/migration-plompy.md). A second MCP process, smoke run or manual login receives `profile_locked` until the first exits. Locks are released on normal shutdown and by the operating system after termination.

## Tools

| Tool | Behavior |
|---|---|
| `browser_open(url, tab?)` | Open a public HTTP(S) URL or navigate an existing observed tab. |
| `browser_tabs()` | List actual tabs with stable tab IDs and titles. |
| `browser_snapshot(tab)` | Read up to 16,000 text characters and 200 visible viewport elements, including role, accessible name and reference. |
| `browser_click(tab, ref)` | Click the observed DOM node using Playwright's native element action. |
| `browser_fill(tab, ref, text)` | Fill an observed editable node; result echoes character count, not entered text. |
| `browser_key(tab, key, ref?)` | Press a bounded in-page editing/navigation key; Enter can submit forms. |
| `browser_scroll(tab, pixels)` | Scroll a bounded distance, then take another snapshot. |
| `browser_screenshot(tab)` | Return an actual PNG as MCP image content and save a private artifact. |
| `browser_close_tab(tab)` | Close a tab without deleting the persistent profile. |

References come from actual observed DOM nodes retained as element handles. They remain stable across snapshots of the same nodes and are invalidated by navigation, tab changes or disappearance from the next snapshot. The caller cannot provide a CSS selector, XPath, arbitrary JavaScript, cookie operation, request header or filesystem path. Snapshots currently cover the main document; iframe contents require separate support. Password input values are omitted. Tool errors report the actual error category and a bounded diagnostic; they do not claim that an uncertain action succeeded or automatically repeat it.

Direct URLs require public HTTP(S), no embedded credentials and port 80/443. DNS checks reject private, loopback, link-local, multicast, reserved and mixed public/private answers. A context route applies the same check to intercepted requests; service workers are blocked and WebRTC is disabled. Query strings and fragments are omitted from reported URLs. This is a **best-effort navigation guard**, not a network security boundary: browser-internal traffic, WebSockets, redirects and DNS rebinding are not proven isolated by these checks. Production isolation needs host/network policy outside MCP. The local stdio process also shares its Unix user's filesystem permissions; it is not a sandbox for malicious web content or an untrusted MCP host.

Page content remains untrusted data. Persistent login does not authorize an action. Account posting, messages and other consequential clicks must follow the owner's active task permissions. The bridge has no proxy settings, CAPTCHA-solving service, access-control bypass, custom browser extension or automatic credential entry.

## Manual login and verification

Stop the job using the profile, then launch the helper as `plompy` inside the private display/VNC session with the same environment above:

```sh
/opt/plompy/current/packages/browser/.venv/bin/python -m plompy_browser.login --url https://x.com/login
```

The owner signs in directly in the headed browser. The helper does not request or read the password. Press Enter in its terminal after login to close cleanly and save the profile. The deployment helper is responsible for keeping VNC on loopback behind an authenticated tunnel, starting/stopping Xvfb and stopping the job first.

Offline checks require no browser download or account credentials:

```sh
cd packages/browser
uv sync --frozen --python 3.14
uv run --frozen pytest -q
```

Tests cover private/mixed DNS navigation, URL redaction, actual exclusive file locks, persisted identity reuse and changed-binary refusal, reference invalidation, exact archive hash/size checking, safe extraction, and actual official MCP stdio tool discovery/private-URL rejection. They do not prove browser launch or account login.

After provisioning the browser on the target host, these opt-in checks use only a neutral public page:

```sh
python -m plompy_browser.smoke
python -m plompy_browser.smoke
python -m plompy_browser.protocol_smoke
```

Run under the service account/display/environment. The first two runs must report identical `identity_file_sha256`; the second must report `identity_reused: true`. Each saves an actual screenshot. `protocol_smoke` exercises the real local stdio client/server, opens `example.com`, snapshots twice to check reference stability, receives an MCP image and checks private-address refusal. None verifies publication, owner-account access or authentication persistence; those need their own authorized real checks.

Primary references: [Camoufox usage and persistent contexts](https://camoufox.com/python/usage/), [official Camoufox release](https://github.com/daijro/camoufox/releases/tag/v158.0.1-beta.41), [official MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk), [Playwright BrowserContext](https://playwright.dev/python/docs/api/class-browsercontext).

The `/opt/plompy` and `/var/lib/plompy` paths above are example host layouts. This public
repository does not include the private installation's bootstrap or service scripts; provision
your own dedicated account/display and substitute your absolute paths.

## Connect the public engine to this bridge

The engine forwards `PLOMPY_BROWSER_DIR` to Codex; this package reads
`PLOMPY_BROWSER_PROFILE`. Map the same absolute private profile explicitly in
`$CODEX_HOME/config.toml` rather than assuming the variable names are interchangeable:

```toml
[mcp_servers.browser]
command = "/absolute/source/packages/browser/.venv/bin/python"
args = ["-m", "plompy_browser"]

[mcp_servers.browser.env]
CAMOUFOX_EXECUTABLE_PATH = "/absolute/browser-install/camoufox-bin"
PLOMPY_BROWSER_PROFILE = "/absolute/private/plompy/browser"
PLOMPY_BROWSER_ARTIFACTS = "/absolute/private/plompy/artifacts/browser"
```

Set the engine's `PLOMPY_BROWSER_DIR` to that same profile path. Manual login must
use the same three browser variables and the same private display. `DISPLAY` and
`XAUTHORITY` are forwarded by the engine when configured on its service.
