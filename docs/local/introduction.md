# Your agent.<br>A little more reach.

Plompy Local connects an agent on your computer to selected tools running behind a local MCP endpoint. Your host client, such as Codex, Claude Code or OpenCode, plans the task and writes the response. Plompy handles the enabled integrations and local artifacts.

Plompy Local is a source-build preview on the repository's `main` branch. Build it with `compose.local.yaml`. It is separate from the published `0.12.0` Discord engine image, which does not contain this mode. Check [Compatibility and verification](compatibility.md) for what has actually been tested.

## Pick your starting point

- [Run locally with Docker](quickstart.md): start the tools gateway, connect a client, and try a small task.
- [Research companies and draft messages](research.md): gather public evidence and save drafts without connecting a mailbox.
- [Use the existing Discord engine](discord.md): let Plompy run a coding agent from your private Discord threads.

## Two ways to use Plompy

| | Plompy Local | Discord engine |
| --- | --- | --- |
| Conversation | Your own MCP client | A private Discord thread |
| Agent | Codex, Claude Code, OpenCode or another compatible client | The runner selected by the engine |
| Plompy provides | Selected tools and artifact storage | Queue, runner sessions, memory and recovery |
| Model credentials in the container | Not required | Required by the selected runner |
| Discord configuration | Not required | Required |
| Compose file | `compose.local.yaml` | `compose.yaml` |

The local gateway does not start a second model behind your host agent. It does not give Plompy access to every account or tool on your computer.

## What stays with you

Configuration, gateway credentials and generated files live in separate Docker volumes. You choose which integrations to enable. External search services and your model provider may receive task data when you use them. Read [Permissions and data flow](security.md) before connecting accounts.

No Plompy subscription or account is needed. Model access and third-party integrations may have their own charges.
