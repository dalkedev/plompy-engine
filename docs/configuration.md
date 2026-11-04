# Configuration

All identities below belong to **your own deployment**. No author account or channel is a default.

| Variable | Required | Meaning |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Your bot token; never passed to Codex children |
| `SZPONT_DISCORD_GUILD_ID` | yes | Your Discord server ID |
| `SZPONT_DISCORD_OWNER_ID` | yes | That server's owner ID |
| `SZPONT_DISCORD_BOT_ID` | yes | Your bot user ID |
| `SZPONT_DISCORD_PARENT_CHANNEL_ID` | yes | Private forum channel ID |
| `SZPONT_WORKSPACE` | yes | Absolute path to your separate private Git workspace |
| `SZPONT_STATE_DIR` | yes | Absolute path for SQLite and singleton lock |
| `SZPONT_ARTIFACTS_DIR` | yes | Absolute path for task output |
| `CODEX_HOME` | yes | Absolute private Codex configuration/login/session directory |
| `SZPONT_BROWSER_DIR` | no | Optional browser state; defaults to `/var/lib/szpont/browser` |
| `SZPONT_CODEX_BIN` | no | Executable path/name; default `codex` |
| `SZPONT_TASK_TIMEOUT_MS` | no | 1,000–3,600,000 ms; default 1,200,000 |

IDs must be 17–20 decimal digits. Enable Discord Developer Mode to copy IDs. Create a bot
application and enable its privileged Message Content Intent. Authorize it for your server
with the permissions required to view the private forum, send messages in threads, read message
history and attach files. Do not grant Administrator merely to make setup easier.

The forum must deny visibility to `@everyone`. The adapter rejects explicit visibility grants
to identities other than the configured owner and bot. Administrators can still bypass channel
visibility, so this is not a promise of secrecy from server administrators. The configured owner
must actually own the server; arbitrary members are not supported by this first edition.

Use the same loaded `CODEX_HOME` for `codex login` and the engine. No model is hardcoded; the
owner configures the CLI account/model. The process adapter targets CLI 0.166.0; upgrading it
requires checking arguments, login status and JSON events against the offline protocol tests.

The engine does not load `.env` itself. Source only your own trusted private environment file
or use your service manager's environment-file support. Do not paste tokens into Discord.

For optional browsing, map the engine profile path explicitly into the MCP server environment,
as shown in [the browser guide](../packages/browser/README.md#connect-the-public-engine-to-this-bridge).
