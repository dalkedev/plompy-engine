# Deployment doctor

Run the preflight as the same operating-system user and with the same trusted private
environment file that will run the engine:

```sh
npm run build
npm run doctor
npm run --silent doctor -- --json
```

The engine does not load `.env` automatically. See [configuration](configuration.md) for
required values. Keep that environment file outside this public source checkout. Do not
paste its contents or account credentials into bug reports.

The default inspection runs locally. It reads directory metadata, asks Git about the
configured workspace, and runs the selected runner executable with `--version`. It does
not start the engine, connect to Discord, submit an inference request, inspect conversations,
open SQLite, initialize a workspace, create directories, repair permissions, or check login.
The diagnostic itself performs no write probe. Run only a runner executable you trust.

Login status requires an explicit additional step:

```sh
npm run doctor -- --check-login
```

For Codex, that opt-in executes `codex login status` using the configured private
`CODEX_HOME` and the engine's child environment allowlist. Other runners use their
[documented local readiness checks](runners.md#credentials-diagnostics-and-acceptance).
The check does not start interactive login or submit a task. Its stdout and stderr are never included in the report. A successful status command does
not prove that a later inference request has quota or will succeed.

## Opt-in Discord inspection

```sh
npm run doctor -- --check-discord
npm run --silent doctor -- --check-login --check-discord --json
```

This explicitly authorizes up to four GET requests to the fixed Discord API origin:
bot identity, configured guild/owner, forum privacy and effective bot reply permissions.
The inspection mirrors the engine's startup privacy rules and separately checks
View Channel, Send Messages in Threads, Read Message History and Attach Files.
It does not request Administrator, create channels, connect a Gateway, send messages,
change permissions or call a model. The bot token stays in authorization headers;
responses and private IDs are not printed.

Each request has at most five seconds; the whole inspection has a fifteen-second
budget and a one-MiB JSON-response limit. Redirects and automatic retries are disabled.
A rate-limit or network failure is a failed inspection, not evidence of wrong credentials.
Default offline reports mark these four `discord_*` checks `NOT_RUN`; explicitly
requested checks are required for overall success. Message Content Intent, incoming
Gateway events, actual thread delivery, provider entitlement and quota remain live
acceptance checks. A REST PASS does not establish those results.

## Checks

Every check has a stable identifier and one of `PASS`, `FAIL`, or `NOT_RUN`:

| Identifier            | What it establishes                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node_runtime`        | The current process uses Node 24.                                                                                                                                                                                                                |
| `configuration`       | The compiled engine configuration loader accepts required values, identity formats, and timeout constraints. No account identity or token is verified remotely.                                                                                  |
| `path_separation`     | Workspace, state, artifacts, selected runner home and browser directories use distinct absolute paths outside public source. Existing symlink aliases and overlapping ancestors are checked, including aliases leading to a missing destination. |
| `private_directories` | Workspace, state, artifacts, selected runner home and browser directories already exist and are directories. The optional browser bridge need not be installed.                                                                                  |
| `private_writability` | The current user has write and traversal access according to the operating system. No files are created to test this.                                                                                                                            |
| `workspace_git`       | The workspace is a Git work tree rooted at its configured path, with writable Git metadata outside public source. A repository inherited from a parent directory is rejected.                                                                    |
| `codex_version`       | The configured executable reports the protocol-tested `codex-cli 0.166.0` version. Other versions need adapter verification before use.                                                                                                          |
| `codex_login`         | `NOT_RUN` by default. With `--check-login`, the configured CLI's status command exits successfully.                                                                                                                                              |

If configuration, path separation, or directory existence fails, dependent checks remain
`NOT_RUN`. The command exits with status `1` when a required check fails, including an
explicitly requested login check. Otherwise it exits with status `0`. A default report can
therefore pass while login remains `NOT_RUN`.

JSON output has `schemaVersion: 1`, an `ok` boolean, and a `checks` array. Each check has
`id`, `status`, `required`, and `message`. Messages use fixed diagnostics: configured paths,
IDs, token values, account details, subprocess output, and raw errors are not printed.

## Fixing a failed preflight

Build first if `configuration` fails in a fresh checkout. Load every required setting from
your own private environment file; the doctor reuses the compiled `loadConfig` rather than
maintaining a second set of engine configuration rules.

For path checks, provision separate private workspace, state, artifact, Codex, and browser
directories as the service user. Avoid nesting one inside another, and check any symlinks.
Initialize the private workspace with the [workspace initializer](../README.md#quick-start)
instead of using the public source repository as agent memory. Directory creation and
permission changes are deliberate deployment steps, not doctor side effects.

For `workspace_git`, ensure Git is installed and that the service user owns a writable Git
repository at the configured workspace root. For `codex_version`, install the documented
version and verify `SZPONT_CODEX_BIN`. For `codex_login`, complete your login separately as
the service user with the same private `CODEX_HOME`, then repeat the opt-in check.

This is a prerequisite snapshot, not a daemon health check or a security audit. It does not
inspect bot/forum permissions, confirm that a worker is running, promise future filesystem
access, or test provider availability. Filesystem state can change after inspection. Keep
service supervision, private backups, and runtime monitoring separate from this command.

## Alternative runner diagnostics

Doctor selects the configured `SZPONT_RUNNER` and checks its private auth directory
instead of requiring an unrelated Codex directory. The version/login check IDs
are prefixed `claude_` or `opencode_` for those runners. Version probes remain
offline and login/readiness requires `--check-login`. OpenCode additionally needs
`opencode_host_execution`; a local credential-entry PASS does not prove remote
authorization. Doctor never enables host execution, changes permissions or logs in.
See [runner setup](runners.md) for pins and acceptance limits.
