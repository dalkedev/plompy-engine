#!/bin/sh
# Usage: sh scripts/docker-smoke.sh IMAGE
# Uses only fresh synthetic volumes, no network, credentials or existing engine state.
set -eu
image=${1:?Usage: sh scripts/docker-smoke.sh IMAGE}
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prefix="plompy-smoke-$(date +%s)-$$"
cleanup() {
  docker volume rm "$prefix-workspace" "$prefix-state" "$prefix-artifacts" "$prefix-codex" "$prefix-github" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
run() {
  if [ "${1:-}" = doctor ]; then
    # Only the explicit offline doctor needs syntactically valid credentials.
    # The ordinary smoke deliberately rejects even a synthetic bot token.
    set -- -e DISCORD_BOT_TOKEN=synthetic-offline-smoke-token \
      -e PLOMPY_DISCORD_GUILD_ID=111111111111111111 \
      -e PLOMPY_DISCORD_OWNER_ID=222222222222222222 \
      -e PLOMPY_DISCORD_BOT_ID=333333333333333333 \
      -e PLOMPY_DISCORD_PARENT_CHANNEL_ID=444444444444444444 \
      "$image" "$@"
  else
    set -- "$image" "$@"
  fi
  if [ -n "${PLOMPY_DOCKER_APPARMOR_PROFILE:-}" ]; then
    set -- --security-opt "apparmor=$PLOMPY_DOCKER_APPARMOR_PROFILE" "$@"
  fi
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --security-opt "seccomp=$repository_root/scripts/docker-seccomp.json" \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
    -v "$prefix-workspace:/var/lib/plompy/workspace" \
    -v "$prefix-state:/var/lib/plompy/state" \
    -v "$prefix-artifacts:/var/lib/plompy/artifacts" \
    -v "$prefix-codex:/var/lib/plompy/codex" \
    -v "$prefix-github:/var/lib/plompy/github" \
    "$@"
}
run init
if run init; then
  echo "FAIL: a second init replaced an existing workspace." >&2
  exit 1
fi
run doctor --json
run sandbox-check
run installation-smoke
run smoke
run smoke
echo "PASS: image can reopen synthetic private volumes without replacing the workspace."
