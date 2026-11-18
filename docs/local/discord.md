# Run Plompy from Discord

The original engine accepts tasks from private Discord threads, stores work in a durable queue and launches a coding runner. That deployment uses the engine repository's `compose.yaml`, its private environment file, its runner credentials and its own volumes.

## Start the stable Discord engine

1. Prepare a Discord bot and a private forum in a server you own. Enable Message Content Intent and copy your server, owner, bot and forum IDs. See [Discord configuration](https://github.com/dalkedev/plompy-engine/blob/main/docs/configuration.md) for permissions.
2. Use Git to clone release `v0.13.0` for its Compose file and follow the [Docker engine first start](https://github.com/dalkedev/plompy-engine/blob/v0.13.0/docs/docker.md#first-start). The Docker image uses Codex. For a Linux service using an experimental Claude Code or OpenCode runner, follow [host deployment](https://github.com/dalkedev/plompy-engine/blob/main/docs/deployment.md).
3. After the structured `ready` event, run the [first private code goal](https://github.com/dalkedev/plompy-engine/blob/main/docs/first-goal.md#use-the-supplied-acceptance-project).

If you already run the engine, use your existing private environment and volumes. For an upgrade from before 0.12, follow the [migration guide](https://github.com/dalkedev/plompy-engine/blob/main/docs/migration-plompy.md).

## Personal assistant preview

The [personal assistant preview](personal-assistant.md) adds notes, tasks and one-time reminders in a dedicated thread in the configured private forum. It requires the `1.0.0-alpha.1` engine image and explicit opt-in.

For MCP tools in a host agent, use the [Local Docker quickstart](quickstart.md). Its `local` or `local-browser` service runs in a separate Compose project with separate private volumes.

## Existing documentation

- [Runner support and boundaries](https://github.com/dalkedev/plompy-engine/blob/main/docs/runners.md)
- [Runner integrations](https://github.com/dalkedev/plompy-engine/blob/main/docs/integrations.md)
- [State backups](https://github.com/dalkedev/plompy-engine/blob/main/docs/state-backups.md)

## Different OpenCode roles

In Discord mode, the engine's experimental OpenCode adapter starts the pinned runner to execute a job. In local mode, your independently running OpenCode client calls Plompy's tools.

Do not point the host client at an engine-managed private runner directory. Do not copy Discord memory, bot credentials or runner auth into the local artifact volume.
