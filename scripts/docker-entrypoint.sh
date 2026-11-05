#!/bin/sh
set -eu
umask 077

# This image only packages and verifies the Codex CLI sandbox. External host
# adapters need their own binaries, private auth storage and isolation acceptance.
if [ "${SZPONT_RUNNER:-codex}" != codex ]; then
  echo "This image supports SZPONT_RUNNER=codex only. See docs/runners.md for experimental host adapters." >&2
  exit 1
fi

if [ "$(id -u)" = 0 ]; then
  echo "Refusing to run Szpont Engine as root." >&2
  exit 1
fi

# Keep developer-tool caches writable without making application files mutable.
# Codex credentials and sessions remain in the separate persistent CODEX_HOME.
mkdir -p "$HOME"
chmod 0700 "$HOME"

case "${1:-engine}" in
  engine)
    mkdir -p "$SZPONT_STATE_DIR" "$SZPONT_ARTIFACTS_DIR" "$CODEX_HOME" "$SZPONT_BROWSER_DIR"
    if [ ! -d "$SZPONT_WORKSPACE/.git" ]; then
      echo "Private workspace is missing. Run the container init command first." >&2
      exit 1
    fi
    # Hold this lock before Node opens SQLite or performs startup recovery.
    exec flock --no-fork -n -E 75 "$SZPONT_STATE_DIR/engine.lock" /bin/sh -ec \
      'node /opt/szpont/scripts/docker-sandbox-check.mjs && exec node /opt/szpont/apps/discord-agent/dist/index.js'
    ;;
  init)
    mkdir -p "$SZPONT_STATE_DIR"
    exec flock --no-fork -n -E 75 "$SZPONT_STATE_DIR/engine.lock" node /opt/szpont/scripts/init-workspace.mjs "$SZPONT_WORKSPACE"
    ;;
  login)
    mkdir -p "$SZPONT_STATE_DIR" "$CODEX_HOME"
    unset DISCORD_BOT_TOKEN SZPONT_GIT_SSH_COMMAND
    exec flock --no-fork -n -E 75 "$SZPONT_STATE_DIR/engine.lock" codex login --device-auth
    ;;
  login-status)
    unset DISCORD_BOT_TOKEN SZPONT_GIT_SSH_COMMAND
    exec codex login status
    ;;
  smoke)
    exec node /opt/szpont/scripts/docker-smoke.mjs
    ;;
  sandbox-check)
    unset DISCORD_BOT_TOKEN SZPONT_GIT_SSH_COMMAND
    exec node /opt/szpont/scripts/docker-sandbox-check.mjs
    ;;
  *)
    exec "$@"
    ;;
esac
