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
ARG VERSION=0.11.1
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Szpont Engine" \
      org.opencontainers.image.description="Self-hosted Discord agent engine with durable jobs and private Markdown memory" \
      org.opencontainers.image.source="https://github.com/dalkedev/szpont-engine" \
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
    && install -d -m 0700 -o node -g node /var/lib/szpont/workspace /var/lib/szpont/state /var/lib/szpont/artifacts /var/lib/szpont/codex /var/lib/szpont/github
ENV NODE_ENV=production \
    SZPONT_CONTAINER_RUNNER=codex \
    HOME=/tmp/szpont-home \
    XDG_CACHE_HOME=/tmp/szpont-cache \
    CODEX_HOME=/var/lib/szpont/codex \
    GH_CONFIG_DIR=/var/lib/szpont/github \
    SZPONT_WORKSPACE=/var/lib/szpont/workspace/current \
    SZPONT_STATE_DIR=/var/lib/szpont/state \
    SZPONT_ARTIFACTS_DIR=/var/lib/szpont/artifacts \
    SZPONT_BROWSER_DIR=/tmp/szpont-browser \
    SZPONT_CODEX_BIN=/usr/local/bin/codex
WORKDIR /opt/szpont
COPY --from=build /build/package.json ./apps/discord-agent/package.json
COPY --from=build /build/dist ./apps/discord-agent/dist
COPY apps/discord-agent/schemas ./apps/discord-agent/schemas
COPY --from=build /build/node_modules ./apps/discord-agent/node_modules
COPY scripts/init-workspace.mjs scripts/docker-smoke.mjs scripts/docker-sandbox-check.mjs scripts/state-snapshot.mjs scripts/integrations.mjs scripts/setup.mjs scripts/doctor.mjs scripts/acceptance.mjs scripts/installation-smoke.mjs ./scripts/
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
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/szpont/scripts/docker-entrypoint.sh"]
CMD ["engine"]
