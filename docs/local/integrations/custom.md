# Custom MCP

Custom MCP remains available in the existing runner integration system. It is not exposed by the first local research profile.

## Why this profile does not enable it

An arbitrary server can give a sending or mutation tool a harmless name and a read-only annotation. An allowlist of names alone would not establish the research profile's promise that it cannot send messages or change external state.

The local CLI therefore rejects enabling custom MCP. Local status identifies it as unsupported, while the existing Discord runner configuration remains unchanged.

## Existing runner setup

Follow the [runner integrations guide](https://github.com/dalkedev/plompy-engine/blob/main/docs/integrations.md) for operator-reviewed remote or stdio servers. Those tools run under that runner's permissions and are not part of the local research contract.

Authentication, dependencies, account access and costs depend on the chosen server. A new integration needs an adapter with explicit semantics, documented permissions and meaningful tests before it joins this profile.

## Alternative for the local workflow

Use the implemented public web and browser readers plus the fixed, selected search integrations in the [catalog](../integrations.md). Do not route a forbidden action through a generic custom tool.

No custom gateway connectivity or live acceptance is claimed.
