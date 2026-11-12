# Bring a browser when a page needs one

Start with the public web tool. Enable Playwright for pages whose useful content appears only after JavaScript renders. The local browser tool reads a page; it does not expose a complete browser automation session.

## Enable the optional profile

Stop the core service before using the browser service: both publish the same loopback port and use the same private volumes.

```sh
docker compose -f compose.local.yaml stop local
docker compose -f compose.local.yaml --profile browser build local-browser
docker compose -f compose.local.yaml --profile browser run --rm local-browser \
  node scripts/integrations.mjs add playwright --mode local
docker compose -f compose.local.yaml --profile browser up -d local-browser
```

Run local status and ask your host client to rediscover tools. A core image with a Playwright entry in its config does not acquire Chromium automatically; it must use the browser image.

## What the tool returns

`browser_read` returns bounded page text, title, links and explicitly published email addresses with their source URL and timestamp. Pages are treated as untrusted input. A published email address has not been verified for deliverability.

## Browser boundaries

- Fresh contexts do not import host cookies or sessions.
- Chromium sandboxing stays enabled.
- Navigation and subresource requests pass through the public-network policy.
- The profile exposes no arbitrary JavaScript execution, form submission, file upload or generic click tool.
- Private network destinations, metadata endpoints and unsafe redirects are blocked by default.

This deliberately narrower browser surface fits research and evidence collection. The existing host Playwright integration offers different capabilities and should not be confused with this profile.

## Bounded page rendering

A browser read has a 30-second operation limit, a 60-request ceiling, at most four concurrent resource fetches, a 5 MiB transfer budget and a 100,000-character text limit. Images, media, fonts, WebSockets, service workers, popups and subsequent frame navigations are not supported. A page depending on those features may be incomplete.

The container uses the dedicated `scripts/docker-browser-seccomp.json` profile for the browser sandbox. It does not enable privileged mode or mount syscalls.

## If the sandbox cannot start

Read the actual container diagnostic and platform compatibility results. Do not add `--no-sandbox`, `privileged`, a Docker socket or a full home mount as a quick fix. The repository's smoke test must show the browser launch and page read on the target environment before you claim browser support there.

[Camoufox](integrations/camoufox.md) is not bundled or advertised as working in this new local container. Its existing Linux host setup remains separate.
