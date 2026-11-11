# Upgrading to Plompy Engine 0.12

**plompy-engine** is the new name of the same engine. Release 0.12.0 keeps SQLite
schema 6, Discord identities, runner bindings, sessions, saved results and the
private Markdown workspace. The repository is now
[`dalkedev/plompy-engine`](https://github.com/dalkedev/plompy-engine); new container
releases use `ghcr.io/dalkedev/plompy-engine`.

A source update does not upgrade a running private installation. Stop the old
worker before starting the new one. Keep your existing private paths and account;
there is no need to create a new Discord application, rotate its token, reinitialize
a workspace, or sign in again just because the project was renamed.

## Prepare an existing installation

1. Finish or stop active work and stop the old service. Keep its service unit,
   source release and container image available for rollback.
2. Take a coordinated private backup of the database, workspace, runner
   authentication/session directories, browser profile/identity, integrations
   registry/configuration, GitHub credentials and environment file. Use the
   [state backup guide](state-backups.md) for SQLite; keep all
   private backups outside this repository.
3. Record absolute state/workspace/auth paths and, for Docker, exact volume names
   from the current container mounts. Do not run `setup` or `init` against an
   existing installation and do not delete or recreate its volumes.

## Linux host installations

Update the checkout remote, install the locked dependencies, and build the new
release. Use the existing service account and private environment file:

```sh
git remote set-url origin https://github.com/dalkedev/plompy-engine.git
git fetch origin --tags
git checkout v0.12.0
npm --prefix apps/discord-agent ci --ignore-scripts --no-audit --no-fund
npm run build
```

Every engine `SZPONT_*` setting remains an alias for its `PLOMPY_*` replacement.
Explicit new settings take precedence, even when empty (an invalid empty value
is rejected). This applies to the engine, doctor and integration wizard. New setup
writes only `PLOMPY_*`. `DISCORD_BOT_TOKEN`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and
`GH_CONFIG_DIR` keep their names. Values are not rewritten:
`/var/lib/szpont/state` remains exactly that path until deliberately migrated.

Rename environment **keys** locally at your own pace; leave path **values** unchanged
for the first upgrade. Keep the same `state/engine.lock` and never run old and new
services simultaneously. A launch command accepting either environment spelling is:

```sh
set -a
. /absolute/private/agent.env
set +a
npm run doctor
flock -n -E 75 "${PLOMPY_STATE_DIR:-$SZPONT_STATE_DIR}/engine.lock" \
  npm --prefix apps/discord-agent start
```

Update the existing service unit's executable checkout path if source was moved.
A service unit/user named `szpont` can remain operationally unchanged; do not create
a second worker merely to rename it. Fresh setup defaults to `~/.local/share/plompy`.
If the legacy default root exists, setup selects it and refuses to overwrite its
managed directories. Explicitly configured paths are preferable.

## Docker: retain the existing volumes

The new Compose project is named `plompy-engine`. **Do not start it against empty
new volumes when upgrading.** `compose.legacy.yaml` maps all five persistent mounts
to existing external volumes. External volumes must already exist; Compose fails
rather than silently creating replacements.

After stopping the old project using its original Compose file, inspect its
mounts and set the old project prefix (the original default was `szpont-engine`):

```sh
export PLOMPY_ENV_FILE=/absolute/private/agent.env
export PLOMPY_LEGACY_COMPOSE_PROJECT=szpont-engine
export PLOMPY_IMAGE=ghcr.io/dalkedev/plompy-engine:0.12.0

docker compose -f compose.yaml -f compose.legacy.yaml config --volumes
docker compose -f compose.yaml -f compose.legacy.yaml pull
docker compose -f compose.yaml -f compose.legacy.yaml run --rm engine doctor
docker compose -f compose.yaml -f compose.legacy.yaml up -d --no-build
```

Keep **both** Compose files on every later command for this upgraded installation.
For custom per-volume names or bind mounts, create a private override matching the
observed mounts instead of assuming the default prefix. `SZPONT_ENV_FILE` remains a
fallback for `PLOMPY_ENV_FILE`; image and volume selection use the explicit new
variables shown above. Never use `down -v` during migration. The legacy override
keeps `/var/lib/szpont/...` paths for upgraded services and additionally mounts the
same five volumes at `/var/lib/plompy/...`. These are real mountpoints, not symlinks
or copied data: both names share the same files and `state/engine.lock` inode. This
preserves strict credential/browser path checks and absolute paths saved in runner
sessions and MCP tables. The read-only `/opt/szpont` code alias resolves to
`/opt/plompy`; existing approved Playwright entries recognize only this same bundled
launcher when inspecting/removing legacy configuration. New approval registration
still requires the current exact launcher. Retain any additional private credential
bind mounts at their original physical paths.

If using the optional AppArmor profile, install/reload `plompy-engine-container`
from `scripts/docker-apparmor` and update the private override. Do not remove the
old profile while it is in use. The new image is published only after the release
pipeline passes; use the release's verified digest for pinned deployments.

## Existing integrations and browser profiles

- `plompy-mcp.json` is the new managed Claude/OpenCode filename. If only
  `szpont-mcp.json` exists, the engine and wizard reuse it in place. If both exist,
  choose explicitly with `PLOMPY_CLAUDE_MCP_CONFIG` or `PLOMPY_OPENCODE_CONFIG`;
  ambiguous automatic discovery fails closed.
- Existing `szpont_*` registry entries and generated integration instructions
  remain readable. New entries use `plompy_*`. Adding the same built-in integration
  while its legacy entry exists is refused to prevent duplicate MCP servers.
  Inspect it first, then explicitly `remove <id> --runner <runner> --yes` followed
  by `add <id> --runner <runner> --yes` with its original setup/auth options.
  Removal preserves credentials, account grants and browser profiles. Private
  command paths may need updating if the checkout or virtual environment moved.
- MCP mutation locks retain legacy filenames so old and new wizards cannot edit
  the same configuration concurrently. Do not delete a live lock.
- The Python package is `plompy-browser`, imported/run as `plompy_browser`.
  Use `uv sync --frozen` to replace the old distribution, or install the
  hash-locked requirements into a fresh release virtual environment. Avoid
  overlapping old/new distributions that own the same compatibility files. The old
  `szpont-browser` command and `python -m szpont_browser` remain compatibility
  aliases, including login and provisioning submodules.
- Browser `SZPONT_BROWSER_PROFILE` and `SZPONT_BROWSER_ARTIFACTS` remain accepted.
  Existing `.szpont-identity.json` is reused without copying or rotating the
  fingerprint. A profile with both identity filenames is rejected until inspected
  explicitly. Both lock names are held, excluding concurrent legacy processes.
- Default browser paths reuse existing legacy directories. If both old and new
  directories exist, set explicit paths. Cookies and authentication are not copied,
  printed, deleted or reset by the rename.

## Validate and roll back

Run offline `doctor`, inspect the private paths and check service logs locally.
Confirm existing thread/session and saved-result readback before authorizing new
model work. Live account actions are not an upgrade smoke test.

The rename does not change the SQLite schema. Rollback means stopping the new
worker and restoring the previous source/image and private configuration together;
use the coordinated backup if another upgrade changed persistent data. Retain old
MCP names/configuration or restore their backups if rolling back to a version that
only understands old names. Never start both versions together.

Historical release notes and Git history retain original names. Legacy identifiers
in current code are deliberate compatibility boundaries, not a second product brand.
