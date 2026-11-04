#!/bin/sh
# Usage: sh scripts/docker-smoke.sh IMAGE
# Uses only fresh synthetic volumes, no network, credentials or existing engine state.
set -eu
image=${1:?Usage: sh scripts/docker-smoke.sh IMAGE}
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prefix="szpont-smoke-$(date +%s)-$$"
cleanup() {
  docker volume rm "$prefix-workspace" "$prefix-state" "$prefix-artifacts" "$prefix-codex" >/dev/null 2>&1 || true
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
    -v "$prefix-workspace:/var/lib/szpont/workspace" \
    -v "$prefix-state:/var/lib/szpont/state" \
    -v "$prefix-artifacts:/var/lib/szpont/artifacts" \
    -v "$prefix-codex:/var/lib/szpont/codex" \
    "$@"
}
run init
if run init; then
  echo "FAIL: a second init replaced an existing workspace." >&2
  exit 1
fi
run sandbox-check
run smoke
run smoke
echo "PASS: image can reopen synthetic private volumes without replacing the workspace."
