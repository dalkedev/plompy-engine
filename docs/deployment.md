# Deployment

Use Linux with Node 24 and a dedicated unprivileged account. Keep the source read-only at
runtime and all writable data outside it. Do not run the engine as root. Install dependencies
from the committed locks, build once, and run the resulting `apps/discord-agent/dist/index.js`.

Keep a single instance. Acquire a lock in the private state directory **before** starting Node,
including before startup recovery. An example foreground command after loading configuration:

```sh
flock -n -E 75 "$SZPONT_STATE_DIR/engine.lock" node /absolute/source/apps/discord-agent/dist/index.js
```

A service manager should provide the private environment file, restrictive umask (0077),
restart-on-failure, no new privileges, private temporary storage and explicit writable paths.
Do not copy the author's host units or credentials; deployment paths and permissions are yours.
This repository does not install a service or modify an existing host.

Authenticate Codex interactively as the service account in its configured `CODEX_HOME`.
Use a harmless local request for acceptance. Verify owner and forum rejection, exact session
resumption and restart interruption before authorizing real account actions. Never use a
public post as a smoke test.

## Optional browser

See [the browser guide](../packages/browser/README.md). A headed browser needs a working
private display, its separately provisioned binary and a persistent profile. Configure its
local stdio MCP command in your private Codex configuration. The engine does not expose a
browser HTTP endpoint. Manual login and automation must not compete for the profile lock.

## Backups and recovery

Back up the private workspace and SQLite state separately from the public source. Use an
appropriate SQLite backup/checkpoint process rather than blindly copying only the main file
while WAL is active. Treat auth caches, browser profiles and full backups as secrets.

After a timeout or crash, inspect `!status`, stored results, journals and actual external state.
Then use `!recover MESSAGE_ID` if appropriate. A timeout alone never authorizes repeating an
external write. A task can succeed while its notification or later memory synchronization fails.

Do not configure a public remote for private memory. If you add a remote sync bridge, keep its
credential out of Codex child processes and verify every allowed path and publication destination.
