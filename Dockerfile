# syntax=docker/dockerfile:1
# The digest identifies the official multi-platform Node 26.13.0 LTS image.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
WORKDIR /build
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && node --version
COPY apps/discord-agent/package.json apps/discord-agent/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/discord-agent/tsconfig.json ./
COPY apps/discord-agent/src ./src
RUN npm run build \
    && node --input-type=module -e 'import { assertSupportedRuntime } from "./dist/node-runtime.js"; assertSupportedRuntime();' \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM build AS mcp-tools
WORKDIR /tools
COPY packages/mcp-bridge/package.json packages/mcp-bridge/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS runtime
ARG VERSION=0.12.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Plompy Engine" \
      org.opencontainers.image.description="Self-hosted Discord agent engine with durable jobs and private Markdown memory" \
      org.opencontainers.image.source="https://github.com/dalkedev/plompy-engine" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git gh libatomic1 ripgrep tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --prefix /opt/codex --omit=dev --ignore-scripts --no-audit --no-fund @openai/codex@0.166.0 \
    && npm cache clean --force \
    && ln -s /opt/codex/node_modules/.bin/codex /usr/local/bin/codex \
    && codex --version \
    && install -d -m 0700 -o node -g node /var/lib/plompy/workspace /var/lib/plompy/state /var/lib/plompy/artifacts /var/lib/plompy/codex /var/lib/plompy/github
ENV NODE_ENV=production \
    PLOMPY_CONTAINER_RUNNER=codex \
    HOME=/tmp/plompy-home \
    XDG_CACHE_HOME=/tmp/plompy-cache \
    CODEX_HOME=/var/lib/plompy/codex \
    GH_CONFIG_DIR=/var/lib/plompy/github \
    PLOMPY_WORKSPACE=/var/lib/plompy/workspace/current \
    PLOMPY_STATE_DIR=/var/lib/plompy/state \
    PLOMPY_ARTIFACTS_DIR=/var/lib/plompy/artifacts \
    PLOMPY_BROWSER_DIR=/tmp/plompy-browser \
    PLOMPY_CODEX_BIN=/usr/local/bin/codex
# Persisted runner sessions and private MCP tables can contain pre-0.12 absolute
# paths. Legacy state uses real mountpoints (credential/browser guards reject
# symlink ancestors); compose.legacy.yaml mounts the same volumes at both paths.
RUN install -d -m 0700 -o node -g node /var/lib/szpont/workspace /var/lib/szpont/state /var/lib/szpont/artifacts /var/lib/szpont/codex /var/lib/szpont/github \
    && ln -s /opt/plompy /opt/szpont
WORKDIR /opt/plompy
COPY --from=build /build/package.json ./apps/discord-agent/package.json
COPY --from=build /build/dist ./apps/discord-agent/dist
COPY apps/discord-agent/schemas ./apps/discord-agent/schemas
COPY --from=build /build/node_modules ./apps/discord-agent/node_modules
COPY scripts/brand-compat.mjs scripts/docker-legacy-smoke.mjs scripts/init-workspace.mjs scripts/docker-smoke.mjs scripts/docker-sandbox-check.mjs scripts/state-snapshot.mjs scripts/integrations.mjs scripts/setup.mjs scripts/doctor.mjs scripts/acceptance.mjs scripts/installation-smoke.mjs ./scripts/
COPY scripts/integrations ./scripts/integrations
COPY --from=mcp-tools /tools/node_modules ./packages/mcp-bridge/node_modules
COPY packages/mcp-bridge/package.json packages/mcp-bridge/bridge.mjs ./packages/mcp-bridge/
COPY packages/mcp-bridge/src ./packages/mcp-bridge/src
# Optional browser source is present; its browser and dependencies are not bundled.
COPY packages/playwright/package.json packages/playwright/launch.mjs packages/playwright/runtime.mjs ./packages/playwright/

COPY --chmod=0755 scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY examples/workspace ./examples/workspace
COPY examples/acceptance ./examples/acceptance
COPY LICENSE ./LICENSE
RUN node --input-type=module -e 'import { assertSupportedRuntime } from "./apps/discord-agent/dist/node-runtime.js"; assertSupportedRuntime();'
USER node:node
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/plompy/scripts/docker-entrypoint.sh"]
CMD ["engine"]
