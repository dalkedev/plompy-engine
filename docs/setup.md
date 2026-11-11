# Guided private setup

`npm run setup` joins workspace initialization and private configuration into one
guided Linux-host flow. Build the checked-out release first with `npm run build`.
Node 26.13.0 or newer 26.x LTS, Git and your selected runner's prerequisites remain operator-managed.
The wizard creates no accounts, services or browser installation, changes no host
security policy, performs no network checks and does not import personal logins.

## Execution environment

Run installation and the filesystem acceptance suite directly as the dedicated
host account, or in the published container. The installer accepts existing
ancestors owned by that account or root, plus root-owned sticky temporary parents.
It deliberately refuses ancestors whose owner cannot be established as trusted.

Some nested agent/user-namespace sandboxes project host root-owned directories to
an overflow UID (commonly 65534). Setup will reject that environment even when a
leaf directory is writable. Do not weaken ownership checks or trust all unmapped
UIDs; run the installer outside that sandbox as the service account. A failing
setup suite there does not establish installation acceptance on the host.

The installer rejects unsupported Node or linked SQLite before creating private
files. Node 26 Linux binaries require libatomic; use your distribution's supported
package-management process to provision it before installing the official runtime.
No host package is installed by this wizard.

## Interactive setup

```sh
npm run setup
```

Choose Codex, Claude Code or OpenCode, then enter the Discord guild, owner, bot
and private-forum IDs. Paste the bot token only at the hidden prompt. The default
root is `$HOME/.local/share/plompy`, with `agent.env` and separate `workspace`,
`state`, `artifacts`, `browser` and selected runner directories. Edit the private
workspace's `agent/USER.md` and `agent/POLICY.md` before authorizing work.

Claude/OpenCode remain experimental Linux host adapters. OpenCode requires an
explicit provider/model and separate host-execution acknowledgement; `--yes` does
not grant it. The published container remains Codex-only. Follow [runners](runners.md)
for authentication and isolation, and [Docker](docker.md) for the volume workflow.

## Automation

Supply real IDs and absolute private paths. A token is never an argument value:

```sh
npm run setup -- --yes --root /srv/private/plompy --runner codex \
  --guild-id GUILD_ID --owner-id OWNER_ID --bot-id BOT_ID --forum-id FORUM_ID \
  --token-file /srv/private/bot-token
```

The token file must be a bounded, owned regular file with mode `0600` inside a
private directory. Alternatively use `--token-stdin` with an explicit noninteractive
`--yes` and a pipe from your trusted secret manager. The two token options are
exclusive; stdin is limited to 4096 token bytes plus one optional line ending and
a thirty-second read deadline. Do not print the token, put it in a public checkout
or use a shell command that exposes it in process arguments or shell history.

`--env-file /absolute/private/agent.env` selects an explicit configuration location.
Environment values are shell-quoted; no credentials are passed to Git initialization.
Directories are private (`0700`), and configuration is mode `0600`. Existing managed
files/directories and aliases into the checkout are refused rather than overwritten
or repaired. Concurrent or incompletely initialized resources of uncertain ownership
are preserved for inspection; a failed setup is not a request to delete existing data.

## Install the selected CLI

The wizard prepares private paths, not executable tools. For the pinned Codex CLI,
use your normal trusted package-management process. A user-local installation is:

```sh
npm install --prefix "$HOME/.local/share/plompy-tools" --omit=dev --ignore-scripts @openai/codex@0.166.0
export PATH="$HOME/.local/share/plompy-tools/node_modules/.bin:$PATH"
codex --version
```

Keep that PATH available to the service as well as the login shell. The container
already includes the pinned CLI. Claude/OpenCode installation and host prerequisites
are described separately in [runners](runners.md).

## Finish and inspect

Use the printed commands, as the account that will run the service:

1. Load the trusted generated environment file; the engine does not auto-load it.
2. Authenticate the selected runner in its new private home.
3. Run `npm run doctor -- --check-login --check-discord`.
4. Start one instance under the printed `flock` command.
5. Verify a harmless task and follow-up in the configured owner's private thread.
6. Use the [first supervised code goal](first-goal.md#use-the-supplied-acceptance-project).

Configuration creation, local readiness, Discord REST access and a completed live
task are separate results. Keep credentials and runtime artifacts out of bug reports.
For persistent service setup, coordinated backups and rollback, see
[deployment](deployment.md) and [state backups](state-backups.md).
