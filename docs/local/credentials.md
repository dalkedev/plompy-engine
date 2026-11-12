# Credentials belong outside the project

There are two kinds of secrets: the local bearer token used by your host client to reach Plompy, and optional integration credentials used by Plompy to reach a vendor. They are separate and are never interchangeable.

## Private storage

The initialization command creates configuration and a gateway token in separate named Docker volumes. Secret directories use owner-only permissions and files use `0600`. The gateway validates credential files before use and rejects unsafe links or ownership.

Artifacts are stored in a third volume. Do not copy credentials into generated CSV, JSON, reports, agent instructions or Git.

## Provide the token to the host client

Your host client needs the local token in its own process environment as `PLOMPY_LOCAL_TOKEN`, or through a supported private file reference. Use the private container-to-host handoff below. Do not display it in a shared terminal or save it in the project configuration.

The generated client configurations include an environment reference, not a literal secret. Environment references work only if that environment variable exists when the host client starts. A variable inside the Plompy container is not automatically available to your host client process.

## Hand the token to your host client

In a private host terminal, with shell tracing disabled, capture the token into
the environment without printing it:

```sh
export PLOMPY_LOCAL_TOKEN="$(docker compose -f compose.local.yaml exec -T local cat /var/lib/plompy-local/secrets/access-token)"
# Start codex, claude or opencode in this terminal after configuring MCP.
```

Use `local-browser` instead of `local` if that is the running service. Do not run
this with `set -x` or copy the resulting environment into diagnostics. Close the
session or `unset PLOMPY_LOCAL_TOKEN` when finished. The command contains no secret
literal; the value remains a secret in the host process environment. Other code
running with the same host account may be able to inspect that environment.

## Add a vendor key

Use the CLI's credential input through stdin. It must not be passed as a command-line argument. Command history, process listings and copied diagnostics can expose arguments.

For example, after configuring Firecrawl API-key mode, run this in a private Bash or Zsh terminal with tracing disabled. Enter the key when `read` waits; it will not echo.

```sh
read -r -s PLOMPY_INTEGRATION_KEY
printf '%s' "$PLOMPY_INTEGRATION_KEY" | docker compose -f compose.local.yaml \
  exec -T local node scripts/integrations.mjs credential firecrawl --stdin --mode local
unset PLOMPY_INTEGRATION_KEY
```

Use the intended integration ID and running service. Existing credentials are preserved unless you explicitly request `--replace`.

A key's presence is a configuration check. Use an explicitly requested live test to verify that the provider accepts it. That test may have a cost or consume the provider's quota.

## OAuth boundaries

The new local gateway does not implement vendor OAuth storage or browser login. Use its supported API-key or keyless paths. Existing host runners can use their native remote MCP OAuth flow as documented in the [existing integrations guide](https://github.com/dalkedev/plompy-engine/blob/main/docs/integrations.md).

A host runner's OAuth session is not imported into Docker. Enabling a service in local mode does not silently start login or copy a browser profile.

## Remove or rotate

Remove an integration's configuration with the local CLI, restart the gateway, and delete or rotate that integration's dedicated credential using the private credential workflow. Revocation at the provider is a separate step. Do not delete unrelated credentials or the entire secret volume to remove one integration.

Rotating the gateway token requires updating the host client's private environment and reconnecting your client. Keep backups of secret volumes encrypted and outside your repository.
