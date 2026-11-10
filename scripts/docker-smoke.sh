#!/bin/sh
# Usage: sh scripts/docker-smoke.sh IMAGE
# Uses only fresh synthetic volumes, no network, credentials or existing engine state.
set -eu
image=${1:?Usage: sh scripts/docker-smoke.sh IMAGE}
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prefix="szpont-smoke-$(date +%s)-$$"
cleanup() {
  docker volume rm "$prefix-workspace" "$prefix-state" "$prefix-artifacts" "$prefix-codex" "$prefix-github" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
run() {
  if [ -n "${SZPONT_DOCKER_APPARMOR_PROFILE:-}" ]; then
    set -- --security-opt "apparmor=$SZPONT_DOCKER_APPARMOR_PROFILE" "$image" "$@"
  else
    set -- "$image" "$@"
  fi
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --security-opt "seccomp=$repository_root/scripts/docker-seccomp.json" \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
    -e DISCORD_BOT_TOKEN=synthetic-offline-smoke-token \
    -e SZPONT_DISCORD_GUILD_ID=111111111111111111 \
    -e SZPONT_DISCORD_OWNER_ID=222222222222222222 \
    -e SZPONT_DISCORD_BOT_ID=333333333333333333 \
    -e SZPONT_DISCORD_PARENT_CHANNEL_ID=444444444444444444 \
    -v "$prefix-workspace:/var/lib/szpont/workspace" \
    -v "$prefix-state:/var/lib/szpont/state" \
    -v "$prefix-artifacts:/var/lib/szpont/artifacts" \
    -v "$prefix-codex:/var/lib/szpont/codex" \
    -v "$prefix-github:/var/lib/szpont/github" \
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
