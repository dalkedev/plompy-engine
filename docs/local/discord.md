# Discord mode is still here

The original engine accepts tasks from private Discord threads, stores work in a durable queue and launches a coding runner. That deployment uses the engine repository's `compose.yaml`, its private environment file, its runner credentials and its own volumes.

The Local starter kit has its own `compose.yaml` in a separate directory and uses the `local` or `local-browser` service. Source developers use `compose.local.yaml` from the repository. Local mode does not require a Discord token or channel. It does not start, migrate or restart your existing Discord bot.

## Existing documentation

- [Docker engine setup](https://github.com/dalkedev/plompy-engine/blob/main/docs/docker.md)
- [Runner support and boundaries](https://github.com/dalkedev/plompy-engine/blob/main/docs/runners.md)
- [Runner integrations](https://github.com/dalkedev/plompy-engine/blob/main/docs/integrations.md)
- [Configuration](https://github.com/dalkedev/plompy-engine/blob/main/docs/configuration.md)
- [State backups](https://github.com/dalkedev/plompy-engine/blob/main/docs/state-backups.md)

## Different OpenCode roles

In Discord mode, the engine's experimental OpenCode adapter starts the pinned runner to execute a job. In local mode, your independently running OpenCode client calls Plompy's tools.

Do not point the host client at an engine-managed private runner directory. Do not copy Discord memory, bot credentials or runner auth into the local artifact volume.

## No automatic migration

There is no need to rename the existing environment, move its state or replace its Compose file to try local tools. Enable the new mode alongside it using separate private volumes and the documented loopback port.
