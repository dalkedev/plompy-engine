#!/bin/sh
set +x
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

service=${1:-local}
if [ "$#" -gt 0 ]; then shift; fi
case "$service" in
  local|local-browser) ;;
  *) fail 'Usage: sh check-local-host.sh local|local-browser [Compose options]' ;;
esac

published=$(docker compose "$@" port "$service" 7331) ||
  fail "Start the $service service before checking its host endpoint."
port=${published#127.0.0.1:}
case "$port" in
  ''|*[!0-9]*) fail 'Expected an IPv4 loopback publication for the gateway.' ;;
esac
[ "$port" -ge 1024 ] && [ "$port" -le 65535 ] ||
  fail 'Expected a published host port from 1024 to 65535.'

# Pass the header over stdin so the bearer token stays out of the host command
# line, temporary files and output. Ignore .curlrc and all proxy settings.
result=$(
  docker compose "$@" exec -T "$service" node --input-type=module -e '
    import { loadConfig } from "./packages/local-mcp/src/config.mjs";
    import { readCredential } from "./packages/mcp-bridge/src/credential.mjs";
    const config = await loadConfig();
    const { token } = await readCredential(config.tokenFile, { excluded: [config.artifactsDir] });
    process.stdout.write(`Authorization: Bearer ${token}\n`);
  ' | curl --disable --noproxy '*' --proto '=http' --fail --silent --show-error \
    --max-time 10 --header @- "http://127.0.0.1:$port/health"
) || fail 'Host check failed. Check the Compose service, its loopback port and local credentials.'

[ "$result" = '{"status":"ready","profile":"research"}' ] ||
  fail 'The published port did not return Plompy Local readiness.'
printf 'Authenticated gateway reached from the host. MCP URL: http://127.0.0.1:%s/mcp\n' "$port"
