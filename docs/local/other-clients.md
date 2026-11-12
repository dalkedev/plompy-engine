# Choose your MCP client

Plompy Local is a tools server. You choose the agent and model on your host. It does not depend on OpenCode's agent loop.

## Documented clients

| Client | Connection guide | Configuration form |
| --- | --- | --- |
| Codex | [Connect Codex](codex.md) | TOML server entry with bearer-token environment variable |
| Claude Code | [Connect Claude Code](claude-code.md) | HTTP MCP server with environment-based authorization header |
| OpenCode | [Connect OpenCode](opencode.md) | Explicit V1 or V2 remote MCP JSON |

The generator commands contain no real token. They do not copy model logins, provider keys or other host credentials into Docker.

## Local model option

[Ollama](ollama.md) can provide local inference to a compatible host agent. It is a model provider, not another MCP client. Tool access still goes through the agent and the Plompy gateway.

## Requirements for another client

A compatible client must support MCP Streamable HTTP, the endpoint `http://127.0.0.1:7331/mcp`, and an `Authorization: Bearer` header supplied through its private credential mechanism. It must support MCP initialization, discovery and tool calls.

Keep the token outside checked-in project configuration. If a client only accepts literal secrets in a shared file or cannot attach an authorization header, do not weaken gateway authentication to make it connect.

## Localhost means the client's machine

The default endpoint is reachable from the host running Docker. A cloud-hosted agent cannot reach your laptop's loopback. A client running in a separate container also has a different loopback interface. This first setup does not provide a public tunnel or a remote-access deployment.

Do not publish port 7331 to the internet as a shortcut. Choose a deliberately secured remote architecture separately if you need one.

## Test one layer at a time

First run the [gateway protocol check](quickstart.md#check-the-local-protocol). Then verify the client's connection and ask it to call `plompy_status`. Finally enable and test one integration with a small task.

An MCP-compatible label is not evidence that every client version has been tested. Read [Compatibility and verification](compatibility.md) for the exact clients and acceptance limits.
