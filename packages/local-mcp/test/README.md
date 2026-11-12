# Local MCP acceptance tests

These tests use synthetic companies, a deterministic local mock model, private
temporary OpenCode directories, and dedicated Docker projects. No model account,
mailbox, provider API key or real company is used. They prove client transport,
tool execution, sandboxed rendering and artifact persistence. They do not prove
live model reasoning quality, paid vendor access or email deliverability.

## Offline tests

```sh
npm ci --prefix packages/local-mcp
npm test --prefix packages/local-mcp
```

## Build and test the real sandboxed browser

The browser target reuses `packages/playwright/package-lock.json`, including
Playwright `1.66.0-alpha-2026-11-09`. Chromium is launched as UID 1000 with its
sandbox enabled. A scoped seccomp profile permits the unprivileged namespace
and `chroot` syscalls it needs. The test verifies the live process command line
contains no flags disabling the sandbox.

```sh
docker compose -f compose.local.yaml --profile browser build local local-browser
docker compose -f compose.local.yaml -p plompy-local-smoke --profile browser run --rm --no-deps -T \
  -v "$PWD/packages/local-mcp/test:/opt/plompy/packages/local-mcp/test:ro" \
  local-browser node packages/local-mcp/test/browser-smoke.mjs
```

The fixture verifies client-rendered contact text, deduplicated email extraction,
the final source URL after a redirect, blocked POST and metadata requests, and
private URL denial without the test-only injected exception. Images, media,
fonts, service workers, WebSockets, popups and subsequent frame navigations are
not supported by this read-only adapter. It is not a full browser automation API.

## Actual OpenCode client and Docker tools

Provide the path to a separately installed **OpenCode 1.19.5** executable. Do not
replace your normal OpenCode installation for this test. The harness rejects
other versions instead of mixing V1 and V2 configuration schemas.

```sh
export OPENCODE_ACCEPTANCE_BIN=/absolute/path/to/opencode-1.19.5
docker compose -f compose.local.yaml -p plompy-local-smoke run --rm --no-deps -T \
  local node scripts/integrations.mjs init --mode local
docker compose -f compose.local.yaml -p plompy-local-smoke up -d --no-build local
node packages/local-mcp/test/opencode-acceptance.mjs "$OPENCODE_ACCEPTANCE_BIN"
node packages/local-mcp/test/docker-persistence-smoke.mjs
```

The harness captures only the freshly generated smoke token in process memory,
never prints it, and never imports host accounts. A local mock OpenAI-compatible
model asks the actual client to call `plompy_status`, `artifacts_export` and
`artifacts_read`. The harness requires completed OpenCode tool events and checks
the actual container file. The restart test compares configuration, access token
and artifact bytes across a real container restart.

## Codex and Claude Code clients

With the same synthetic core container running, the sibling-client harness uses
the installed `codex` and `claude` executables in separate temporary homes:

```sh
node packages/local-mcp/test/client-acceptance.mjs
```

Verified client versions are Codex CLI **0.159.2** and Claude Code **2.1.197**.
Codex parses the bearer-environment configuration, initializes the real Docker
MCP server and executes `plompy_status`. A deterministic local Responses mock
receives that real tool result. The harness also requires Codex's completed MCP
tool event; configuration parsing alone is insufficient to pass.

Claude Code performs an actual authenticated MCP health connection and reports
`Connected`. It uses the client's environment-placeholder header format. This
check does **not** run a Claude agent/model turn. No live model account, model
reasoning quality, provider API access or mailbox is claimed by either check.

The HTTP transport tests additionally cover a real fixture SSE connection that
stays open after returning a result. The SDK can consume the result immediately;
cancellation closes the underlying socket, and byte/time limits remain active
while streaming. Private destinations and redirects stay blocked.

## Full synthetic research flow

This separate test binds the gateway to host loopback port **17331**. Its
test-only entry point injects one exact private fixture address into the network
adapter. The production server has no environment/config switch granting that
exception, and test sources are excluded from the image build context.

```sh
docker compose -f compose.local.yaml -f packages/local-mcp/test/compose.research-fixture.yaml \
  -p plompy-local-acceptance run --rm --no-deps -T \
  local node scripts/integrations.mjs init --mode local
docker compose -f compose.local.yaml -f packages/local-mcp/test/compose.research-fixture.yaml \
  -p plompy-local-acceptance up -d --no-build local
node packages/local-mcp/test/opencode-acceptance.mjs "$OPENCODE_ACCEPTANCE_BIN" \
  plompy-local-acceptance-local-1 --research
```

Eight real MCP calls cover status, reading a synthetic search result, rendering
three source pages, deduplicating their observed email contacts to two companies,
preparing deterministic drafts from those observed facts, exporting JSON and CSV,
and reading CSV. The mock model derives export records from actual tool results.
The final container files are checked, including a formula-like company name
that must be escaped in CSV. This is a fixture search page, not a live search
provider; it is explicitly labelled synthetic throughout the test.

## Remove only these test instances

The following commands intentionally remove **only the dedicated synthetic test
projects and their test volumes**. They do not address the normal `plompy-local`
project. Do not use these project names for personal data.

```sh
docker compose -f compose.local.yaml -p plompy-local-smoke down --volumes
docker compose -f compose.local.yaml -f packages/local-mcp/test/compose.research-fixture.yaml \
  -p plompy-local-acceptance down --volumes
```

The locally built images remain available. Nothing is pushed to an image registry.
