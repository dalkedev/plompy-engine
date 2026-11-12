# What you need

## On your computer

- Docker Engine or Docker Desktop with Docker Compose.
- The [0.13.0 Local starter kit](quickstart.md), downloaded with `curl` and extracted with `tar` or equivalent tools.
- A compatible host MCP client, such as Codex, Claude Code or OpenCode, configured with a model you can use.
- A free host port, `7331` by default.

Docker runs the gateway on Linux. macOS and Windows users need Docker's Linux container environment. Published Local images support Linux `amd64` and `arm64`. The browser needs a working Chromium sandbox; see [browser setup](browser.md) for the optional Linux AppArmor profile. Platform-specific acceptance results belong in [Compatibility](compatibility.md).

## Inside the image

The local image uses the repository's pinned Node 26 runtime and committed dependency lock. The core target contains the gateway and its light dependencies. The optional browser target adds the pinned Playwright/Chromium dependencies.

The process runs without root privileges. There is no Docker socket mount, full home-directory mount, privileged container or automatic import of host accounts.

## Model and integration access

Keep model credentials in your host client. Plompy Local needs no model subscription or agent account of its own. See [client connection options](other-clients.md).

Each external integration has separate requirements. A model subscription is not automatically a Perplexity API allowance or a Firecrawl subscription. Read the [integration catalog](integrations.md) before enabling a provider.

## Choose the correct image

- `ghcr.io/dalkedev/plompy-engine:0.13.0-local`: core MCP gateway, public web reads, integrations and artifacts.
- `ghcr.io/dalkedev/plompy-engine:0.13.0-local-browser`: the same gateway plus sandboxed Chromium.
- `ghcr.io/dalkedev/plompy-engine:0.13.0`: the separate Discord/Codex engine.

The starter kit selects the Local images. You do not need Git, Node or a compiler on the host. For development or an inspected source revision, use [Build from source](source-build.md).

## Running without Docker

The package can also run with Node 26.13.0 or a newer Node 26 release, the committed lock, and a private configuration outside the checkout. This is useful for development. Docker is the documented onboarding path; host mode has the permissions of the host user.

Do not reuse a private Discord engine workspace as the local gateway's artifact or credential directory.
