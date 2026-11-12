# GitHub

Plompy's existing GitHub integration uses `gh`. The local gateway wraps selected read operations rather than pretending that `gh` is a remote MCP server.

## Set up

```sh
docker compose -f compose.local.yaml exec local \
  node scripts/integrations.mjs add github --mode local
```

The current adapter requires a dedicated, minimally scoped GitHub token even when reading public repositories. Provide it through the local credential command or an explicitly configured private file. Do not import the host's complete GitHub config or use your primary token merely because it is convenient.

## Permissions

This research profile does not expose arbitrary `gh` arguments, shell commands, repository writes, issue creation, comments, pull requests or merges. The two tools are `github_search_repositories` (a query, at most 20 results) and `github_repository` (an owner and repository name). Inspect their schemas in the client before using the adapter.

## Try it

```text
Inspect the public repository I named using the available GitHub read
tools. Summarize the project and link the evidence. Do not modify it.
```

## Costs and diagnostics

GitHub account, API and rate limits apply. Credential presence is not proof of access to a repository. A live test must target a deliberately selected repository and report the result; never open an issue or write a comment as a smoke test.

GitHub is optional for company research. Public company websites can be read without it.
