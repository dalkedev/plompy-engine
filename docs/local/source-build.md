# Build a selected source revision

The [starter kit](quickstart.md) is the shortest route to a running gateway. Use this guide when you want to inspect or modify the implementation and build your own images. Source builds require Git and Docker Compose; the Docker build installs the locked Node dependencies.

## Check out the release

```sh
git clone --branch v0.13.1 --depth 1 https://github.com/dalkedev/plompy-engine.git
cd plompy-engine
docker compose -f compose.local.yaml build local
docker compose -f compose.local.yaml run --rm -T local \
  node scripts/integrations.mjs init --mode local
docker compose -f compose.local.yaml up -d local
docker compose -f compose.local.yaml exec -T local \
  node scripts/integrations.mjs test --mode local
```

The repository's `compose.local.yaml` builds `Dockerfile.local` and uses development image names. The repository's plain `compose.yaml` starts the separate Discord engine. Always keep `-f compose.local.yaml` on source-build commands.

The Local source Compose project and downloaded starter kit both default to the project name `plompy-local`. Use a different project name and loopback port for an independent development instance with its own volumes.

## Use a different host port

Choose an available TCP port from `1024` to `65535` and set `PLOMPY_LOCAL_HOST_PORT` in the local Compose `.env` file. Use a unique Compose project name for a second instance. For example, with a separate checkout, set:

```dotenv
COMPOSE_PROJECT_NAME=plompy-local-dev
PLOMPY_LOCAL_HOST_PORT=17331
```

Build and start with `-f compose.local.yaml` as above. To apply the port to a running installation, run `docker compose -f compose.local.yaml up -d --force-recreate local` using its existing project name. Docker still publishes only on `127.0.0.1`. Private config, the access token and artifacts stay in their volumes. Check the actual port and regenerate your client fragment before reconnecting:

```sh
sh scripts/check-local-host.sh local -f compose.local.yaml
docker compose -f compose.local.yaml exec -T local \
  node scripts/integrations.mjs codex --mode local
```

## Build the browser variant

```sh
docker compose -f compose.local.yaml stop local
docker compose -f compose.local.yaml --profile browser build local-browser
docker compose -f compose.local.yaml --profile browser run --rm -T local-browser \
  node scripts/integrations.mjs add playwright --mode local
docker compose -f compose.local.yaml --profile browser up -d local-browser
```

The browser sandbox still applies. The source seccomp profile is `scripts/docker-browser-seccomp.json`; a release bundle places its corresponding file beside `compose.yaml`. For Linux AppArmor requirements, see [Browser setup](browser.md). The source profile is `scripts/docker-local-apparmor`. If adapting the release kit's Compose override for this checkout, use `seccomp=./scripts/docker-browser-seccomp.json` and retain `-f compose.local.yaml` as the base file.

## Use the other guides

Continue with [Choose your client](other-clients.md), using `docker compose -f compose.local.yaml` wherever a guide shows plain `docker compose`. Use `local-browser` instead of `local` when the browser variant is running.

The host agent and model remain outside the gateway. Building from source does not create model access, vendor credentials or new tool permissions.

## Rebuild after a source change

Stop the selected service, build that target, and start it again using the same Compose project and volumes. Repeat its authenticated protocol check and inspect a saved artifact. Keep the previous revision and a private volume backup until the new image works.

The [local MCP test guide](https://github.com/dalkedev/plompy-engine/blob/main/packages/local-mcp/test/README.md) documents fixture-based acceptance checks. Fixture endpoints and test model servers are development tools, not normal research configuration.
