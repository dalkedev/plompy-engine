#!/bin/sh
set -eu
umask 077

# Read-only compatibility with pre-0.12 private environment files.
if [ "${PLOMPY_RUNNER+set}" != set ] && [ "${SZPONT_RUNNER+set}" = set ]; then PLOMPY_RUNNER=$SZPONT_RUNNER; export PLOMPY_RUNNER; fi
if [ "${PLOMPY_STATE_DIR+set}" != set ] && [ "${SZPONT_STATE_DIR+set}" = set ]; then PLOMPY_STATE_DIR=$SZPONT_STATE_DIR; export PLOMPY_STATE_DIR; fi
if [ "${PLOMPY_ARTIFACTS_DIR+set}" != set ] && [ "${SZPONT_ARTIFACTS_DIR+set}" = set ]; then PLOMPY_ARTIFACTS_DIR=$SZPONT_ARTIFACTS_DIR; export PLOMPY_ARTIFACTS_DIR; fi
if [ "${PLOMPY_WORKSPACE+set}" != set ] && [ "${SZPONT_WORKSPACE+set}" = set ]; then PLOMPY_WORKSPACE=$SZPONT_WORKSPACE; export PLOMPY_WORKSPACE; fi
if [ "${PLOMPY_BROWSER_DIR+set}" != set ] && [ "${SZPONT_BROWSER_DIR+set}" = set ]; then PLOMPY_BROWSER_DIR=$SZPONT_BROWSER_DIR; export PLOMPY_BROWSER_DIR; fi
if [ "${PLOMPY_CODEX_BIN+set}" != set ] && [ "${SZPONT_CODEX_BIN+set}" = set ]; then PLOMPY_CODEX_BIN=$SZPONT_CODEX_BIN; export PLOMPY_CODEX_BIN; fi
if [ "${PLOMPY_CONTAINER_RUNNER+set}" != set ] && [ "${SZPONT_CONTAINER_RUNNER+set}" = set ]; then PLOMPY_CONTAINER_RUNNER=$SZPONT_CONTAINER_RUNNER; export PLOMPY_CONTAINER_RUNNER; fi
if [ "${PLOMPY_DISCORD_GUILD_ID+set}" != set ] && [ "${SZPONT_DISCORD_GUILD_ID+set}" = set ]; then PLOMPY_DISCORD_GUILD_ID=$SZPONT_DISCORD_GUILD_ID; export PLOMPY_DISCORD_GUILD_ID; fi
if [ "${PLOMPY_DISCORD_OWNER_ID+set}" != set ] && [ "${SZPONT_DISCORD_OWNER_ID+set}" = set ]; then PLOMPY_DISCORD_OWNER_ID=$SZPONT_DISCORD_OWNER_ID; export PLOMPY_DISCORD_OWNER_ID; fi
if [ "${PLOMPY_DISCORD_BOT_ID+set}" != set ] && [ "${SZPONT_DISCORD_BOT_ID+set}" = set ]; then PLOMPY_DISCORD_BOT_ID=$SZPONT_DISCORD_BOT_ID; export PLOMPY_DISCORD_BOT_ID; fi
if [ "${PLOMPY_DISCORD_PARENT_CHANNEL_ID+set}" != set ] && [ "${SZPONT_DISCORD_PARENT_CHANNEL_ID+set}" = set ]; then PLOMPY_DISCORD_PARENT_CHANNEL_ID=$SZPONT_DISCORD_PARENT_CHANNEL_ID; export PLOMPY_DISCORD_PARENT_CHANNEL_ID; fi
if [ "${PLOMPY_TASK_TIMEOUT_MS+set}" != set ] && [ "${SZPONT_TASK_TIMEOUT_MS+set}" = set ]; then PLOMPY_TASK_TIMEOUT_MS=$SZPONT_TASK_TIMEOUT_MS; export PLOMPY_TASK_TIMEOUT_MS; fi

# This image only packages and verifies the Codex CLI sandbox. External host
# adapters need their own binaries, private auth storage and isolation acceptance.
if [ "${PLOMPY_RUNNER:-codex}" != codex ]; then
  echo "This image supports PLOMPY_RUNNER=codex only. See docs/runners.md for experimental host adapters." >&2
  exit 1
fi

if [ "$(id -u)" = 0 ]; then
  echo "Refusing to run Plompy Engine as root." >&2
  exit 1
fi

# Keep developer-tool caches writable without making application files mutable.
# Codex credentials and sessions remain in the separate persistent CODEX_HOME.
mkdir -p "$HOME"
chmod 0700 "$HOME"

case "${1:-engine}" in
  engine)
    mkdir -p "$PLOMPY_STATE_DIR" "$PLOMPY_ARTIFACTS_DIR" "$CODEX_HOME" "$PLOMPY_BROWSER_DIR"
    if [ ! -d "$PLOMPY_WORKSPACE/.git" ]; then
      echo "Private workspace is missing. Run the container init command first." >&2
      exit 1
    fi
    # Hold this lock before Node opens SQLite or performs startup recovery.
    exec flock --no-fork -n -E 75 "$PLOMPY_STATE_DIR/engine.lock" /bin/sh -ec \
      'node /opt/plompy/scripts/docker-sandbox-check.mjs && exec node /opt/plompy/apps/discord-agent/dist/index.js'
    ;;
  init)
    mkdir -p "$PLOMPY_STATE_DIR"
    exec flock --no-fork -n -E 75 "$PLOMPY_STATE_DIR/engine.lock" node /opt/plompy/scripts/init-workspace.mjs "$PLOMPY_WORKSPACE"
    ;;
  login)
    mkdir -p "$PLOMPY_STATE_DIR" "$CODEX_HOME"
    unset DISCORD_BOT_TOKEN PLOMPY_GIT_SSH_COMMAND SZPONT_GIT_SSH_COMMAND
    exec flock --no-fork -n -E 75 "$PLOMPY_STATE_DIR/engine.lock" codex login --device-auth
    ;;
  login-status)
    unset DISCORD_BOT_TOKEN PLOMPY_GIT_SSH_COMMAND SZPONT_GIT_SSH_COMMAND
    exec codex login status
    ;;
  integrations)
    shift
    mkdir -p "$PLOMPY_STATE_DIR"
    unset DISCORD_BOT_TOKEN PLOMPY_GIT_SSH_COMMAND SZPONT_GIT_SSH_COMMAND GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
    exec flock --no-fork -n -E 75 "$PLOMPY_STATE_DIR/engine.lock" node /opt/plompy/scripts/integrations.mjs "$@"
    ;;
  smoke)
    exec node /opt/plompy/scripts/docker-smoke.mjs
    ;;
  installation-smoke)
    unset DISCORD_BOT_TOKEN PLOMPY_GIT_SSH_COMMAND SZPONT_GIT_SSH_COMMAND GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
    exec node /opt/plompy/scripts/installation-smoke.mjs
    ;;
  doctor)
    shift
    # Each one-shot container has a fresh tmpfs, independent of the service.
    # Prepare only its configured ephemeral browser directory; do not repair
    # missing persistent volumes or initialize a workspace.
    mkdir -p "$PLOMPY_BROWSER_DIR"
    unset PLOMPY_GIT_SSH_COMMAND SZPONT_GIT_SSH_COMMAND GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
    exec node /opt/plompy/scripts/doctor.mjs "$@"
    ;;
  setup|acceptance)
    cli_command=$1
    shift
    unset DISCORD_BOT_TOKEN PLOMPY_GIT_SSH_COMMAND SZPONT_GIT_SSH_COMMAND GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
    exec node "/opt/plompy/scripts/$cli_command.mjs" "$@"
    ;;
  sandbox-check)
    unset DISCORD_BOT_TOKEN PLOMPY_GIT_SSH_COMMAND SZPONT_GIT_SSH_COMMAND
    exec node /opt/plompy/scripts/docker-sandbox-check.mjs
    ;;
  *)
    exec "$@"
    ;;
esac
