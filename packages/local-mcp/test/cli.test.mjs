import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, lstat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable, Readable } from "node:stream";
import { runLocalIntegrations } from "../../../scripts/local-integrations.mjs";
import { runIntegrations } from "../../../scripts/integrations.mjs";
import { startServer } from "../src/server.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "plompy-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = [];
  const invoke = (args, extras = {}) => runLocalIntegrations([...args, "--root", root], { env: {}, print: (value) => logs.push(value), ...extras });
  await invoke(["init"]);
  return { root, logs, invoke, configPath: join(root, "config", "config.json") };
}

test("initializes without Discord or model credentials and preserves existing private state", async (t) => {
  const { root, invoke, logs, configPath } = await fixture(t);
  const before = await readFile(configPath, "utf8"), config = JSON.parse(before);
  const token = await readFile(config.tokenFile, "utf8");
  assert.match(token.trim(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(root, "secrets"))).mode & 0o777, 0o700);
  await invoke(["init"]);
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal(await readFile(config.tokenFile, "utf8"), token);
  assert.ok(!logs.join("\n").includes(token.trim()));
  await rm(config.tokenFile);
  await assert.rejects(invoke(["init"]), /Restore its private token/);
  await assert.rejects(lstat(config.tokenFile), { code: "ENOENT" });
});

test("enables only explicitly selected remote tools, records credentials privately, and removes configuration only", async (t) => {
  const { invoke, logs, configPath } = await fixture(t);
  await assert.rejects(invoke(["add", "firecrawl", "--auth", "keyless"]), /explicit upstream/);
  await invoke(["add", "firecrawl", "--auth", "keyless", "--tools", "firecrawl_search,firecrawl_scrape"]);
  await invoke(["credential", "firecrawl", "--stdin"], { readSecret: async () => "synthetic-test-secret-only" });
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.integrations.firecrawl.allowedTools, ["firecrawl_search", "firecrawl_scrape"]);
  const credential = config.integrations.firecrawl.credentialFile;
  assert.equal(await readFile(credential, "utf8"), "synthetic-test-secret-only\n");
  assert.ok(!logs.join("\n").includes("synthetic-test-secret-only"));
  assert.ok(!(await readFile(configPath, "utf8")).includes("synthetic-test-secret-only"));
  await invoke(["status", "firecrawl"]);
  assert.equal(JSON.parse(logs.at(-1))[0].state, "configured");
  assert.match(JSON.parse(logs.at(-1))[0].diagnostic, /Not live-tested/);
  await assert.rejects(invoke(["credential", "firecrawl", "--stdin"], { readSecret: async () => "next-synthetic-token" }), /already exists/);
  await invoke(["remove", "firecrawl"]);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).integrations.firecrawl, undefined);
  assert.equal(await readFile(credential, "utf8"), "synthetic-test-secret-only\n");
});

test("exports explicit OpenCode schemas, never embeds the local access token", async (t) => {
  const { invoke, logs, configPath } = await fixture(t);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await assert.rejects(invoke(["opencode"]), /client-version/);
  await invoke(["opencode", "--client-version", "v1"]);
  const v1 = JSON.parse(logs.at(-1));
  assert.equal(v1.mcp.plompy.enabled, true);
  assert.equal(v1.mcp.plompy.headers.Authorization, "Bearer {env:PLOMPY_LOCAL_TOKEN}");
  await invoke(["opencode", "--client-version", "v2"]);
  const v2 = JSON.parse(logs.at(-1));
  assert.equal(v2.mcp.servers.plompy.disabled, false);
  assert.equal(v2.mcp.servers.plompy.oauth, false);
  assert.ok(!logs.join("\n").includes((await readFile(config.tokenFile, "utf8")).trim()));
});

test("Codex and Claude Code exports use their native schemas without revealing secrets or overwriting config", async (t) => {
  const { root, invoke, logs, configPath } = await fixture(t);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  config.server.port = 8123;
  config.server.allowedHosts = ["127.0.0.1:8123"];
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await invoke(["codex"]);
  const toml = logs.at(-1);
  assert.match(toml, /^\[mcp_servers\.plompy\]\n/);
  assert.match(toml, /url = "http:\/\/127\.0\.0\.1:8123\/mcp"/);
  assert.match(toml, /bearer_token_env_var = "PLOMPY_LOCAL_TOKEN"/);
  assert.ok(!toml.includes(token));
  await invoke(["claude-code"]);
  const claude = JSON.parse(logs.at(-1));
  assert.deepEqual(claude, { mcpServers: { plompy: { type: "http", url: "http://127.0.0.1:8123/mcp",
    headers: { Authorization: "Bearer ${PLOMPY_LOCAL_TOKEN}" } } } });
  assert.ok(!logs.at(-1).includes(token));
  const target = join(root, "existing-client.json");
  const original = '{"unrelated":"preserve"}\n';
  await writeFile(target, original, { mode: 0o600 });
  for (const client of ["codex", "claude-code"])
    await assert.rejects(invoke([client, "--write", target]), /print-only/);
  assert.equal(await readFile(target, "utf8"), original);
});

test("explicit OpenCode write preserves unrelated keys and private backup, refuses JSONC and schema conflicts", async (t) => {
  const { root, invoke, logs } = await fixture(t);
  const target = join(root, "opencode.json");
  const original = { model: "fixture/model", provider: { test: { token: "synthetic-existing-secret" } }, mcp: { docs: { type: "remote", url: "https://example.invalid/mcp" } } };
  await writeFile(target, JSON.stringify(original), { mode: 0o600 });
  await invoke(["opencode", "--client-version", "v1", "--write", target]);
  const modified = JSON.parse(await readFile(target, "utf8"));
  assert.equal(modified.model, original.model);
  assert.deepEqual(modified.provider, original.provider);
  assert.deepEqual(modified.mcp.docs, original.mcp.docs);
  const backups = (await readdir(root)).filter((name) => name.startsWith("opencode.json.plompy-backup-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(root, backups[0]), "utf8")), original);
  assert.equal((await lstat(join(root, backups[0]))).mode & 0o777, 0o600);
  assert.ok(!logs.join("\n").includes("synthetic-existing-secret"));
  await assert.rejects(invoke(["opencode", "--client-version", "v2", "--write", target]), /different schema/);
  await writeFile(target, "{ // JSONC preserved\n}");
  await assert.rejects(invoke(["opencode", "--client-version", "v1", "--write", target]), /not strict JSON/);
  assert.equal(await readFile(target, "utf8"), "{ // JSONC preserved\n}");
});

test("V2 config writes preserve global MCP options and other servers", async (t) => {
  const { root, invoke } = await fixture(t);
  const target = join(root, "opencode.json");
  const original = { mcp: { timeout: 12345, servers: { docs: { type: "remote", url: "https://example.invalid/mcp" } } } };
  await writeFile(target, JSON.stringify(original), { mode: 0o600 });
  await invoke(["opencode", "--client-version", "v2", "--write", target]);
  const value = JSON.parse(await readFile(target, "utf8"));
  assert.equal(value.mcp.timeout, 12345);
  assert.deepEqual(value.mcp.servers.docs, original.mcp.servers.docs);
  assert.equal(value.mcp.servers.plompy.disabled, false);
});

test("local diagnostic calls real authenticated MCP status without discovering remote vendors", async (t) => {
  const { invoke, logs, configPath } = await fixture(t);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  config.integrations.firecrawl = { enabled: true, auth: "keyless", allowedTools: ["firecrawl_search"] };
  let vendorConnections = 0;
  const service = await startServer(config, { token, port: 0, toolOptions: { remoteConnector: async () => { vendorConnections++; throw new Error("Must not contact vendors"); } } });
  t.after(() => service.close());
  config.server.port = service.address.port;
  config.server.allowedHosts = [`127.0.0.1:${service.address.port}`];
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await invoke(["test"]);
  const status = JSON.parse(logs.at(-1));
  assert.equal(status.state, "available");
  assert.deepEqual(status.checks, ["authenticated MCP initialization", "local status tool"]);
  assert.equal(vendorConnections, 0);
  await writeFile(config.tokenFile, "wrong-synthetic-access-token\n", { mode: 0o600 });
  await assert.rejects(invoke(["test"]), /Local MCP check failed/);
  assert.equal(vendorConnections, 0);
});

test("refuses unsafe paths, unavailable integrations and unsupported secret arguments", async (t) => {
  const { root, invoke, configPath } = await fixture(t);
  await assert.rejects(invoke(["add", "camoufox"]), /not exposed/);
  await assert.rejects(invoke(["add", "tinyfish"]), /not exposed/);
  await assert.rejects(invoke(["add", "custom", "--url", "https://example.invalid/mcp", "--tools", "send_mail"]), /not exposed/);
  await assert.rejects(invoke(["credential", "firecrawl", "--token", "synthetic-secret"]), /Unknown local CLI/);
  await assert.rejects(invoke(["test", "firecrawl"]), /--live/);
  const sourceDescendant = fileURLToPath(new URL("../../../..private-token-test/config/config.json", import.meta.url));
  await assert.rejects(runLocalIntegrations(["init", "--config", sourceDescendant], { env: {}, print: () => {} }), /outside the public checkout/);
  const link = join(root, "config-link.json");
  await symlink(configPath, link);
  await assert.rejects(invoke(["status", "--config", link]), /owner-only|symlink/);
});

test("existing integrations entry point dispatches local mode before requiring Discord paths", async (t) => {
  const { root } = await fixture(t);
  let text = "";
  const output = new Writable({ write(chunk, encoding, callback) { text += chunk.toString(); callback(); } });
  await runIntegrations(["status", "--mode", "local", "--root", root], { env: {}, output, input: Readable.from([]) });
  assert.equal(JSON.parse(text).find((entry) => entry.id === "web").state, "configured");
});
