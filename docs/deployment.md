# Deployment

Use Linux with Node 26.13.0 or newer 26.x LTS and a dedicated unprivileged account. Keep the source read-only at
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

Authenticate the selected runner as the service account in its private configuration
directory. Codex uses `CODEX_HOME`; see [runners](runners.md) for Claude Code and
OpenCode installation, auth paths and host isolation requirements.
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

Use the [state snapshot tool](state-backups.md) for a verified online SQLite backup.
Version 0.8.0 migrates public schemas 0–5 transactionally to schema 6 without replaying
work. Take a pre-upgrade snapshot and stop the engine before switching versions;
0.7.0 and earlier must not open migrated state.

After a timeout or crash, inspect `!status`, stored results, journals and actual external state.
Then use `!recover MESSAGE_ID` if appropriate. A timeout alone never authorizes repeating an
external write. A task can succeed while its notification or later memory synchronization fails.

For bounded `!work` goals, a verified budget pause leaves the conversation available. Uncertain
turns block it and require explicit recovery with their remaining budget, or a fresh
`!work 30m <goal>` budget that reconciles actions before continuing the saved session. Export/commit failures
retry independently; they do not start another model turn. See [work sessions](work-sessions.md).

Do not configure a public remote for private memory. If you add a remote sync bridge, keep its
credential out of model child processes and verify every allowed path and publication destination.

The provider-adapter release advances public SQLite state to schema 3; all legacy
conversations and jobs retain Codex bindings. Keep a compatible pre-upgrade snapshot
and every auth directory needed by existing threads. See [runner upgrades](runners.md#bindings-and-upgrades).

Version 0.5.0 advances public SQLite state to schema 4 for private image attachments,
preserving provider bindings. State snapshots now contain image bytes. Keep state
owned by the service account with mode `0700`; native-input files use private
per-turn directories there and are cleaned on the next singleton-locked startup
after a crash. See [image input](image-input.md) before enabling attachment intake.

Version 0.6.0 retains schema 4 and adds guided integration setup and explicit
fresh-budget recovery. Stop the service before changing tools; runtime configuration
is loaded on startup. An integration status check is separate from a harmless live
acceptance test. See [integration setup](integrations.md) and [work sessions](work-sessions.md).

Version 0.6.1 retains the same state schema and adds read-only `!queue` inspection.
Use it to distinguish recovery, runner readiness and an earlier accepted task from
shared-worker waiting. It does not start a model, retry work or provide a start-time estimate.

Version 0.7.0 adds [supervised goals](supervised-goals.md) and migrates public state
to schema 5. Take a coordinated snapshot before upgrading and retain the matching
binary and workspace for rollback. Verify actual worker session resume and a fresh
supervisor on the deployment; offline tests do not establish model/MCP readiness.

Version 0.8.0 adds [owner-bound code diff evidence](goal-code-diffs.md) and migrates
public state to schema 6. Stop the service and retain a coordinated pre-upgrade
snapshot, workspace checkpoint and binary before switching versions. Version
0.7.0 cannot open schema 6. Existing goals remain unbound. Use a new explicit
`!goal --repo` command to select a repository; in a blocked thread this authorizes
fresh recovery work. A plain `!recover` note does not change the binding, and a
normal goal does not discover code repositories.
Verify the chosen repository path, sealed before/after evidence and actual reviewer
access on your deployment. Derived review files can be regenerated from SQLite;
do not substitute a later live diff for a saved candidate during recovery.
