// Real sibling clients against the synthetic Docker smoke instance only.
// Claude: authenticated MCP health connection, no agent/model turn.
// Codex: actual MCP tool call with a deterministic local Responses mock model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const container = "plompy-local-smoke-local-1";
const token = (await exec("docker", ["exec", container, "cat", "/var/lib/plompy-local/secrets/access-token"], { timeout: 5000 })).stdout.trim();
assert.ok(token.length >= 32);
const temporary = await mkdtemp(join(tmpdir(), "plompy-clients-acceptance-"));
let mock, child;
const environment = { PATH: process.env.PATH, LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1", PLOMPY_LOCAL_TOKEN: token };
for (const directory of ["home", "config", "data", "cache", "state", "project", "codex", "claude"]) await mkdir(join(temporary, directory), { mode: 0o700 });
Object.assign(environment, {
  HOME: join(temporary, "home"), XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"),
  XDG_CACHE_HOME: join(temporary, "cache"), XDG_STATE_HOME: join(temporary, "state"), CODEX_HOME: join(temporary, "codex"),
  CLAUDE_CONFIG_DIR: join(temporary, "claude"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ANTHROPIC_API_KEY: "synthetic-no-account",
});
const report = {};
try {
  const claudeVersion = (await exec("claude", ["--version"], { env: environment, timeout: 5000 })).stdout.trim();
  const mcp = JSON.stringify({ type: "http", url: "http://127.0.0.1:7331/mcp", headers: { Authorization: "Bearer ${PLOMPY_LOCAL_TOKEN}" } });
  await exec("claude", ["mcp", "add-json", "plompy", mcp, "--scope", "user"], { cwd: join(temporary, "project"), env: environment, timeout: 10_000 });
  const health = await exec("claude", ["mcp", "list"], { cwd: join(temporary, "project"), env: environment, timeout: 20_000 });
  assert.match(health.stdout, /plompy.*Connected/i);
  assert.ok(!health.stdout.includes(token));
  report.claude = { version: claudeVersion, result: "pass", checked: "real authenticated MCP health connection", agentTurn: "not tested; no model account used" };

  const codexVersion = (await exec("codex", ["--version"], { env: environment, timeout: 5000 })).stdout.trim();
  let requests = 0, requestedTool, receivedToolOutput, mockFailure;
  mock = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
      let raw = "";
      for await (const chunk of request) { raw += chunk; if (raw.length > 2_000_000) throw new Error("Oversized mock input."); }
      const body = JSON.parse(raw);
      if (++requests > 4) throw new Error("Unexpected repeated fixture requests.");
      let item;
      if (!requestedTool) {
        const names = (body.tools ?? []).flatMap((tool) => tool.type === "namespace" ? (tool.tools ?? []).map((child) => ({ ...child, namespace: tool.name })) : [tool]);
        const tool = names.find((tool) => tool.name === "plompy_status" || /plompy.*plompy_status$/.test(tool.name));
        assert.ok(tool, "Codex must expose the discovered Plompy status tool.");
        requestedTool = tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name;
        item = { id: "fc_fixture_status", type: "function_call", call_id: "call_fixture_status", name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: "{}", status: "completed" };
      } else {
        receivedToolOutput = (body.input ?? []).find((input) => input.type === "function_call_output" && input.call_id === "call_fixture_status");
        assert.ok(receivedToolOutput, "A real MCP result must return to Codex and reach the local mock model.");
        assert.match(JSON.stringify(receivedToolOutput), /research/);
        item = { id: "msg_fixture_done", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "The actual Plompy MCP status call succeeded. No external provider or email was used.", annotations: [] }] };
      }
      const base = { id: `resp_fixture_${requests}`, object: "response", created_at: 1, model: "fixture", status: "in_progress", output: [] };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      emit("response.created", { response: base });
      emit("response.output_item.added", { output_index: 0, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] } });
      if (item.type === "function_call") {
        emit("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: "{}" });
        emit("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: "{}" });
      } else {
        emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
        emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text });
        emit("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
      }
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    } catch (error) { mockFailure ??= error; response.writeHead(500); response.end("Synthetic fixture assertion failed."); }
  }).listen(0, "127.0.0.1");
  await once(mock, "listening");
  const config = `model = "fixture"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.fixture]
name = "Local deterministic fixture"
base_url = "http://127.0.0.1:${mock.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[mcp_servers.plompy]
url = "http://127.0.0.1:7331/mcp"
bearer_token_env_var = "PLOMPY_LOCAL_TOKEN"
`;
  await writeFile(join(temporary, "codex", "config.toml"), config, { mode: 0o600 });
  const parsed = await exec("codex", ["mcp", "get", "plompy", "--json"], { env: environment, cwd: join(temporary, "project"), timeout: 10_000 });
  assert.match(parsed.stdout, /bearer_token_env_var/);
  let stdout = "", stderr = "";
  child = spawn("codex", ["exec", "--skip-git-repo-check", "--ephemeral", "--json", "--color", "never", "--sandbox", "read-only", "--ignore-rules", "-C", join(temporary, "project"), "Execute the fixture-requested Plompy status tool call only. Do not use shell, web or email."],
    { env: environment, cwd: join(temporary, "project"), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 60_000);
  let code;
  try { [code] = await once(child, "exit"); } finally { clearTimeout(timer); }
  if (mockFailure) throw mockFailure;
  if (code !== 0) throw new Error(`Codex fixture failed (${code}): ${stderr.split(token).join("[REDACTED]").slice(-2000)}`);
  assert.ok(receivedToolOutput);
  assert.equal(requests, 2);
  const events = stdout.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const completed = events.find((event) => event.type === "item.completed" && event.item?.type === "mcp_tool_call" && event.item.status === "completed");
  assert.ok(completed, "Codex must report the actual completed MCP tool call.");
  assert.ok(!stdout.includes(token));
  report.codex = { version: codexVersion, result: "pass", checked: "actual MCP tool call", tool: requestedTool, model: "deterministic local Responses mock, no account", requests };
  console.log(JSON.stringify(report));
} finally {
  if (child?.pid && child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  if (mock) { mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); }
  await rm(temporary, { recursive: true, force: true });
}
