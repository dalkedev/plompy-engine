# Keep your model local with Ollama

Ollama is a model provider, not an MCP client. Run a compatible agent such as Codex, Claude Code or OpenCode on your host, connect it to Ollama for inference, and connect that same agent to Plompy for tools.

```text
You -> host agent -> Ollama model on your host
                 -> Plompy MCP in Docker -> selected tools and artifacts
```

The Plompy container does not need a model or an Ollama login. This path has not been run in the current acceptance checks; no Ollama model was downloaded. See [Compatibility](compatibility.md).

## Choose a tool-capable model

Use an installed model that supports tool calls and your chosen client. A model that chats successfully may still fail to select a tool, produce valid arguments or follow source requirements. The client integrations recommend a large context window, commonly at least 64k tokens. Larger contexts and models require more memory; choose them for your machine.

Follow the current [Ollama integration guides](https://docs.ollama.com/integrations/overview) for model compatibility and setup. Review any model download's size and license yourself before installing it.

## OpenCode with Ollama

After installing and configuring Ollama, its integration launcher can configure OpenCode:

```sh
ollama launch opencode
```

Then add the Plompy MCP entry from [Connecting OpenCode](opencode.md), matching your installed V1 or V2 version. Preserve the model-provider configuration created by the launcher. Do not paste an older V1 provider block into V2 without checking its schema.

The [official OpenCode integration guide](https://docs.ollama.com/integrations/opencode) also describes manual provider configuration. Its local OpenAI-compatible endpoint is typically `http://localhost:11434/v1`.

## Codex with Ollama

Replace `YOUR_INSTALLED_MODEL` with the exact name of an installed tool-capable model before running this template:

```sh
codex --oss --local-provider ollama -m 'YOUR_INSTALLED_MODEL'
```

Set up the [Codex MCP connection](codex.md) separately and provide `PLOMPY_LOCAL_TOKEN` to the same Codex process. `--oss` changes the model-provider path; it does not configure Plompy for you. See [Ollama's Codex guide](https://docs.ollama.com/integrations/codex).

## Claude Code with Ollama

Ollama provides a Claude Code launcher:

```sh
ollama launch claude
```

Its documented manual environment route is below. Replace `YOUR_INSTALLED_MODEL` before running; the quoted name is a placeholder, not a recommended model:

```sh
ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY='' \
  ANTHROPIC_BASE_URL=http://localhost:11434 \
  claude --model 'YOUR_INSTALLED_MODEL'
```

These values select Ollama's local compatibility endpoint; `ollama` here is the documented placeholder, not a real vendor credential. Keep your [Claude Code MCP connection](claude-code.md) and local Plompy token configured separately. Follow [Ollama's Claude Code guide](https://docs.ollama.com/integrations/claude-code) for current client compatibility.

## Local inference and external requests

Local inference keeps the selected model call on your machine when the model and endpoint are local. Research tools still fetch public sites. Enabled Firecrawl, Perplexity, PostHog and other remote integrations can receive requests and task data. Ollama also offers cloud models, so check the actual selected model and endpoint before assuming inference is local.

Start with a small status and page-read task. Inspect the tool calls and source URLs before asking a model to produce a larger company list. Plompy's no-send research profile remains the same regardless of which model you choose.
