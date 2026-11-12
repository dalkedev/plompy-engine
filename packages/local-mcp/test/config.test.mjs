import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "../src/config.mjs";

const defaults = (root = "/private/test-only-plompy") => ({ schemaVersion: 1,
  server: { host: "0.0.0.0", port: 7331, allowedHosts: ["127.0.0.1:7331", "localhost:7331"], allowedOrigins: [] },
  tokenFile: join(root, "secrets", "token"), artifactsDir: join(root, "artifacts"),
  integrations: { web: { enabled: true }, playwright: { enabled: false } },
});

test("config allows separate container listening and loopback access hosts without Discord", () => {
  const config = defaults();
  assert.equal(validateConfig(config), config);
  config.server.allowedOrigins = ["http://127.0.0.1:7331"];
  assert.equal(validateConfig(config), config);
});

test("config rejects broadened hosts/origins, plaintext secrets, invalid tools and unsafe destinations", () => {
  const changes = [
    (c) => { c.schemaVersion = 2; },
    (c) => { c.secret = "synthetic-secret"; },
    (c) => { c.server.host = "192.168.1.1"; },
    (c) => { c.server.port = 80; },
    (c) => { c.server.allowedHosts = ["*"]; },
    (c) => { c.server.allowedHosts = ["127.0.0.1:9999"]; },
    (c) => { c.server.allowedOrigins = ["https://evil.example"]; },
    (c) => { c.server.allowedOrigins = ["null"]; },
    (c) => { c.server.disableAuth = true; },
    (c) => { c.tokenFile = join(c.artifactsDir, "token"); },
    (c) => { c.tokenFile = join(c.artifactsDir, "..secrets", "token"); },
    (c) => { c.artifactsDir = "/"; },
    (c) => { c.integrations.execute = { enabled: true }; },
    (c) => { c.integrations.firecrawl = { enabled: true, credentialFile: join(c.artifactsDir, "key") }; },
    (c) => { c.integrations.firecrawl = { enabled: true, credentialFile: join(c.artifactsDir, "..secrets", "key") }; },
    (c) => { c.integrations.firecrawl = { enabled: true, credentialFile: c.tokenFile }; },
    (c) => { c.integrations.firecrawl = { enabled: true, credentialFile: c.tokenFile.replace("/secrets/token", "/secrets/../secrets/token") }; },
    (c) => { c.integrations.firecrawl = { enabled: true, apiKey: "synthetic-secret" }; },
    (c) => { c.integrations.firecrawl = { enabled: true, allowedTools: ["*"] }; },
    (c) => { c.integrations.firecrawl = { enabled: true, allowedTools: ["firecrawl_search", "firecrawl_search"] }; },
    (c) => { c.integrations.custom = { enabled: true, url: "http://public.example/mcp" }; },
    (c) => { c.integrations.custom = { enabled: true, url: "https://user:password@public.example/mcp" }; },
    (c) => { c.integrations.custom = { enabled: true, url: "https://public.example/mcp?token=synthetic" }; },
    (c) => { c.integrations.custom = { enabled: true, url: "https://public.example:8443/mcp" }; },
  ];
  for (const change of changes) { const config = defaults(); change(config); assert.throws(() => validateConfig(config)); }
});

test("private config loading rejects links, public modes and oversized files", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "plompy-config-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "config"), path = join(directory, "config.json");
  await mkdir(directory, { mode: 0o700 });
  const config = defaults(root);
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await loadConfig(path), config);
  await writeFile(path, JSON.stringify({ ...config, tokenFile: path }), { mode: 0o600 });
  await assert.rejects(loadConfig(path), /separate credential file/);
  await writeFile(path, JSON.stringify({ ...config, integrations: { firecrawl: { enabled: true, auth: "api-key", credentialFile: path } } }), { mode: 0o600 });
  await assert.rejects(loadConfig(path), /separate from configuration/);
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await symlink(path, join(directory, "alias.json"));
  await assert.rejects(loadConfig(join(directory, "alias.json")), /symlinks/);
  await link(path, join(directory, "hardlink.json"));
  await assert.rejects(loadConfig(path), /Private integration JSON/);
  await rm(join(directory, "hardlink.json"));
  await chmod(path, 0o644);
  await assert.rejects(loadConfig(path), /Private integration JSON/);
  await chmod(path, 0o600);
  await chmod(directory, 0o755);
  await assert.rejects(loadConfig(path), /0700/);
  await chmod(directory, 0o700);
  await writeFile(path, " ".repeat(65_537), { mode: 0o600 });
  await assert.rejects(loadConfig(path), /Private integration JSON/);
});
