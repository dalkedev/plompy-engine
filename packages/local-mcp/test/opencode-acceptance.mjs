// Real OpenCode V1 + real Docker MCP, deterministic local mock model.
// This verifies transport/tool execution, not live model quality or vendor access.
// Usage: node packages/local-mcp/test/opencode-acceptance.mjs /absolute/opencode
// Requires a freshly initialized plompy-local-smoke-local-1 container on 7331.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
const binary = process.argv[2];
const container = process.argv[3] ?? "plompy-local-smoke-local-1";
const research = process.argv[4] === "--research";
const endpoint = research ? "http://127.0.0.1:17331/mcp" : "http://127.0.0.1:7331/mcp";
if (!binary || !isAbsolute(binary) || !/^plompy-local-(?:smoke|acceptance)[a-z0-9-]*-local-1$/.test(container))
  throw new Error("Use an absolute OpenCode binary path and a dedicated synthetic smoke/acceptance container.");
const version = (await exec(binary, ["--version"], { timeout: 5000 })).stdout.trim();
assert.equal(version, "1.19.5", "This acceptance config is pinned to OpenCode 1.19.5.");
const token = (await exec("docker", ["exec", container, "cat", "/var/lib/plompy-local/secrets/access-token"], { timeout: 5000 })).stdout.trim();
assert.ok(token.length >= 32);
const configured = JSON.parse((await exec("docker", ["exec", container, "cat", "/var/lib/plompy-local/config/config.json"], { timeout: 5000 })).stdout);
assert.deepEqual(Object.entries(configured.integrations).filter(([, value]) => value.enabled).map(([key]) => key), ["web"],
  "Use a fresh fixture-only instance. This test must not contact configured vendor accounts.");

const temporary = await mkdtemp(join(tmpdir(), "plompy-opencode-acceptance-"));
const runId = randomUUID().replaceAll("-", "");
const artifact = `opencode-acceptance-${runId}.json`;
let records = [{ company_name: "Synthetic mobile studio", website: "https://fixture.example", public_email: "team@fixture.example", source_url: "https://fixture.example/contact", evidence_status: "synthetic_fixture", draft_subject: "University project collaboration", draft_body: "Synthetic draft only. No email was sent." }];
const steps = research ? [
  { suffix: "plompy_status", args: {} },
  { suffix: "web_fetch", args: { url: "http://127.0.0.1:18881/search?q=mobile+Poland" } },
  { suffix: "browser_read", args: { url: "http://127.0.0.1:18881/companies/aurora" } },
  { suffix: "browser_read", args: { url: "http://127.0.0.1:18881/companies/aurora-copy" } },
  { suffix: "browser_read", args: { url: "http://127.0.0.1:18881/companies/cedar" } },
  { suffix: "artifacts_export", args: () => ({ name: artifact, format: "json", records: researchRecords(), idempotencyKey: `${runId}-json` }) },
  { suffix: "artifacts_export", args: () => ({ name: artifact.replace(/json$/, "csv"), format: "csv", records, idempotencyKey: `${runId}-csv` }) },
  { suffix: "artifacts_read", args: { name: artifact.replace(/json$/, "csv") } },
] : [
  { suffix: "plompy_status", args: {} },
  { suffix: "artifacts_export", args: { name: artifact, format: "json", records, idempotencyKey: runId } },
  { suffix: "artifacts_read", args: { name: artifact } },
];
const observed = [];
let phase = 0, modelRequests = 0, modelFailure, child, childOutput = "", childError = "";
function findResults(messages) {
  return messages.filter((message) => message.role === "tool").map((message) => ({ id: message.tool_call_id, content: message.content }));
}
function objects(value) {
  if (typeof value === "string") { try { return objects(JSON.parse(value)); } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(objects);
  if (value && typeof value === "object") return [value, ...Object.values(value).flatMap(objects)];
  return [];
}
function researchRecords() {
  const pages = observed.flatMap((result) => objects(result.content)).filter((value) => Array.isArray(value.emails) && typeof value.text === "string");
  assert.equal(pages.length, 3, "Three real browser reads must reach the mock model.");
  const unique = new Map();
  for (const page of pages) {
    assert.match(page.text, /mobile applications.*Poland/);
    assert.equal(page.emails.length, 1);
    const email = page.emails[0];
    assert.equal(email.source_url, page.url);
    if (unique.has(email.email)) continue;
    unique.set(email.email, { company_name: page.title, website: page.url, industry: "Mobile application development", location: "Poland",
      public_email: email.email, source_url: email.source_url, checked_at: page.checked_at,
      match_reason: "The source states that this studio develops mobile applications for companies in Poland.",
      evidence_status: page.evidence_status,
      draft_subject: `University project proposal for ${page.title}`,
      draft_body: `Hello ${page.title}, your website says that you develop mobile applications for companies in Poland. I am looking for a university project collaboration. Would you be open to discussing a small student project? This is a synthetic draft, not a sent email.` });
  }
  records = [...unique.values()];
  assert.equal(records.length, 2, "Duplicate published contact must be removed using actual source data.");
  return records;
}
const mock = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
    let raw = "";
    for await (const chunk of request) { raw += chunk; if (raw.length > 2_000_000) throw new Error("Unexpected model input size."); }
    const body = JSON.parse(raw); modelRequests++;
    if (modelRequests > steps.length + 3) throw new Error("Unexpected repeated model requests.");
    assert.equal(body.model, "fixture");
    const results = findResults(body.messages ?? []);
    observed.push(...results.filter((result) => !observed.some((seen) => seen.id === result.id)));
    let delta, finish;
    if (phase < steps.length) {
      if (phase > 0) assert.ok(observed.some((result) => result.id === `fixture-call-${phase - 1}`), "The previous real MCP tool result must reach OpenCode before the next step.");
      const step = steps[phase];
      if (research && phase === 2) {
        const search = observed.flatMap((result) => objects(result.content)).find((value) => typeof value.content === "string" && value.url?.includes("/search?"));
        assert.ok(search, "The real fixture search page must reach OpenCode.");
        for (const path of ["/companies/aurora", "/companies/aurora-copy", "/companies/cedar"])
          assert.ok(search.content.includes(`href=\"${path}\"`), "Browser targets must appear in the actual search result.");
      }
      const offered = (body.tools ?? []).find((tool) => tool.function?.name === `plompy_${step.suffix}`);
      assert.ok(offered, `OpenCode must expose the real plompy_${step.suffix} MCP tool.`);
      const args = typeof step.args === "function" ? step.args() : step.args;
      delta = { role: "assistant", tool_calls: [{ index: 0, id: `fixture-call-${phase}`, type: "function", function: { name: offered.function.name, arguments: JSON.stringify(args) } }] };
      finish = "tool_calls"; phase++;
    } else {
      assert.ok(observed.some((result) => result.id === `fixture-call-${steps.length - 1}`));
      delta = { role: "assistant", content: "The synthetic local acceptance is complete. The real MCP calls returned. No email was sent." };
      finish = "stop";
    }
    const base = { id: `fixture-${modelRequests}`, object: "chat.completion.chunk", created: 1, model: "fixture" };
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) { modelFailure = error; response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Synthetic acceptance assertion failed." } })); }
}).listen(0, "127.0.0.1");
await once(mock, "listening");
try {
  for (const directory of ["home", "config", "data", "cache", "state", "project"]) await mkdir(join(temporary, directory), { mode: 0o700 });
  const permission = { "*": "deny", "plompy_*": "allow" };
  const config = {
    "$schema": "https://opencode.ai/config.json",
    model: "fixture/fixture", small_model: "fixture/fixture", enabled_providers: ["fixture"],
    autoupdate: false, share: "disabled", plugin: [], formatter: false, lsp: false, permission,
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Local deterministic fixture", options: { baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: "synthetic-no-account" }, models: { fixture: { name: "Fixture", limit: { context: 32768, output: 1024 } } } } },
    mcp: { plompy: { type: "remote", url: endpoint, enabled: true, oauth: false, headers: { Authorization: "Bearer {env:PLOMPY_LOCAL_TOKEN}" } } },
  };
  await writeFile(join(temporary, "project", "opencode.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  const environment = {
    PATH: process.env.PATH, LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1",
    HOME: join(temporary, "home"), XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"),
    XDG_CACHE_HOME: join(temporary, "cache"), XDG_STATE_HOME: join(temporary, "state"),
    OPENCODE_CONFIG: join(temporary, "project", "opencode.json"), OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_PERMISSION: JSON.stringify(permission), PLOMPY_LOCAL_TOKEN: token,
  };
  child = spawn(binary, ["run", "--pure", "--format", "json", "--model", "fixture/fixture", "--title", "Plompy synthetic acceptance", "Execute the synthetic fixture's requested Plompy MCP calls. Do not use shell, web tools, other providers or email."],
    { cwd: join(temporary, "project"), env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { childOutput += chunk; if (childOutput.length > 2_000_000) process.kill(-child.pid, "SIGKILL"); });
  child.stderr.on("data", (chunk) => { childError += chunk; if (childError.length > 100_000) process.kill(-child.pid, "SIGKILL"); });
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 60_000);
  let code;
  try { [code] = await once(child, "exit"); } finally { clearTimeout(timer); }
  if (modelFailure) throw modelFailure;
  if (code !== 0) throw new Error(`OpenCode failed (${code}). ${childError.split(token).join("[REDACTED]").slice(-1500)}`);
  assert.equal(phase, steps.length, `All planned MCP calls must occur. ${childError.slice(-500)}`);
  assert.equal(observed.length, steps.length);
  const outputText = JSON.stringify(observed);
  assert.match(outputText, /research/);
  assert.match(outputText, research ? /Fixture Aurora/ : /Synthetic mobile studio/);
  assert.ok(!outputText.includes(token));
  const stored = JSON.parse((await exec("docker", ["exec", container, "cat", `/var/lib/plompy-local/artifacts/${artifact}`], { timeout: 5000 })).stdout);
  assert.deepEqual(stored, records, "A real Docker artifact, not mock model text, must contain the exact supplied records.");
  const events = childOutput.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const completed = events.filter((event) => event.type === "tool_use" && event.part?.state?.status === "completed");
  assert.equal(completed.length, steps.length, "OpenCode must report all MCP calls completed.");
  if (research) {
    const csv = (await exec("docker", ["exec", container, "cat", `/var/lib/plompy-local/artifacts/${artifact.replace(/json$/, "csv")}`], { timeout: 5000 })).stdout;
    assert.match(csv, /"'=Fixture Cedar"/);
    assert.equal(csv.split("\r\n").filter(Boolean).length, 3);
    assert.ok(observed.some((result) => JSON.stringify(result.content).includes("source_url")));
  }
  console.log(JSON.stringify({ result: "pass", client: `OpenCode ${version}`, model: "deterministic local mock, no model account", mcp: "real Docker server", calls: completed.map((event) => event.part.tool), persistedArtifact: artifact, modelRequests, ...(research ? { sourcesRead: 3, deduplicatedCompanies: records.length, csvFormulaProtected: true, fixtureOnly: true } : {}), publicEmailSent: false }));
} finally {
  if (child?.pid && child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
