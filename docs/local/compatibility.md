# What has been verified

These pages describe the Local MCP source-build preview on the repository's `main` branch. Publishing its documentation does not create a container release. Local mode is not included in `v0.12.0`, and no Plompy Local registry image is published for this preview.

## Version boundaries

| Component | Contract |
| --- | --- |
| Local runtime | Node 26.13.0 or newer Node 26 |
| MCP SDK | Pinned by `packages/local-mcp/package-lock.json` |
| Docker | Source build from `Dockerfile.local` |
| Host clients | Codex and Claude Code export; explicit OpenCode V1 or V2 config |
| Local inference | Ollama configuration guide, not tested in this acceptance run |
| Existing engine OpenCode runner | Independently pinned to 1.19.5 |
| Browser | Pinned optional Playwright dependency, sandbox enabled |
| Existing published engine release | 0.12.0, Discord/Codex image |

## Verification levels

- **Offline:** synthetic credentials, local fixtures and controlled responses. This can verify validation and error handling without proving vendor access.
- **Container:** the actual built image starts, authenticates an MCP client and performs the checked local operations.
- **Real browser:** Chromium runs inside the browser image and reads a controlled fixture with sandboxing enabled.
- **Real OpenCode client:** the actual client discovers or calls the gateway. A deterministic model fixture is not a real model-provider acceptance test.
- **Live provider:** an explicitly authorized call to a real account succeeds. Record provider, tool, date and outcome without secrets.

## Acceptance record

The following checks were completed on 12 November 2026. The test sources and reproducible commands are in the [local MCP test guide](https://github.com/dalkedev/plompy-engine/blob/main/packages/local-mcp/test/README.md).

| Check | Result and boundary |
| --- | --- |
| Core and browser Docker images | Both source targets built successfully. No image was pushed to a registry. |
| Real sandboxed browser | Chromium ran as UID 1000 with no sandbox-disabling flag. It read JavaScript-rendered contacts, retained the final source URL, and blocked POST and metadata requests. |
| Actual Codex 0.159.2 client | An isolated client parsed the generated TOML and completed `plompy_status` against Docker. A deterministic local Responses mock handled two model requests; a completed MCP tool event was asserted. |
| Actual Claude Code 2.1.197 client | An isolated client completed an authenticated MCP connection health check and reported Connected. No Claude agent/model turn was run. |
| Actual OpenCode 1.19.5 client | An isolated client completed eight real MCP calls against Docker for a synthetic research task. A deterministic local mock model directed the calls. |
| Research artifacts | Three controlled source pages produced two deduplicated company records, draft content, JSON and CSV. Stored files and formula-safe CSV were checked. |
| Container restart | Configuration, gateway token and exact artifact bytes persisted across a real restart. |
| Public OpenAI Docs | Real remote initialization and `search_openai_docs` with query `API Responses` and limit 1 succeeded at 15:31 UTC. No model account or paid inference was used. |
| Other paid API providers | Not live-tested with account credentials. Offline validation does not prove provider access. |
| OpenCode V2 | Configuration generation is supported; the V2 client was not exercised in the recorded acceptance run. |
| Ollama | Documented setup only. Ollama and local-model quality were not tested, and no model was downloaded. |

A configuration export or CLI registration alone must not be described as a completed model-powered task. The Codex and OpenCode checks used actual clients with controlled model fixtures; the Claude Code check covered authenticated server connectivity only.

The synthetic research test proves client transport, tool execution, rendering and persistence. It does not prove live search-provider coverage, paid model reasoning quality, mailbox access or email deliverability. Third-party integration failures remain possible because of authentication, plan limits, changed tool names or service availability.

## Deliberate first-version limits

- No email sending, mailbox integration or bulk outreach.
- No nested agent or model inside the gateway.
- No automatic import of host credentials or browser profiles.
- No vendor OAuth implementation in the gateway.
- No Camoufox Docker support in this profile.
- No TinyFish autonomous task tool in the research profile.
- No arbitrary custom MCP servers in the local research profile.
- No generic shell, arbitrary browser script or unrestricted tool-invocation endpoint.
- Documentation content is English; the existing landing retains English and Polish routes.
