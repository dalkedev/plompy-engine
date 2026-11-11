// Offline migration acceptance: synthetic mounts/credentials only, no MCP launch.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readCredential } from "../packages/mcp-bridge/src/credential.mjs";
import { privateDirectory } from "../packages/playwright/runtime.mjs";
import { inspectMcp, unregisterMcp } from "./integrations/mcp.mjs";

assert.equal(await realpath("/var/lib/szpont"), "/var/lib/szpont");
for (const name of ["workspace", "state", "artifacts", "codex", "github"]) {
  const old = await stat(`/var/lib/szpont/${name}`), current = await stat(`/var/lib/plompy/${name}`);
  assert.equal(old.dev, current.dev);
  assert.equal(old.ino, current.ino, `${name} must be the same mounted volume`);
}
const root = await mkdtemp("/var/lib/szpont/state/legacy-smoke-");
const output = await mkdtemp("/var/lib/szpont/artifacts/legacy-smoke-");
const credential = "/var/lib/szpont/credentials/synthetic.key";
try {
  await writeFile(credential, "synthetic-offline-credential\n", { mode: 0o600, flag: "wx" });
  assert.equal((await readCredential(credential)).token, "synthetic-offline-credential");
  assert.equal(await privateDirectory(output), output);
  const cache = join(root, "cache");
  await privateDirectory(cache, { create: true });
  const codexHome = join(root, "codex");
  await mkdir(codexHome, { mode: 0o700 });
  const server = { command: process.execPath, args: ["/opt/szpont/packages/playwright/launch.mjs", "--output-dir", output, "--browser-cache", cache] };
  const configPath = join(codexHome, "config.toml");
  await writeFile(configPath, `[mcp_servers."szpont_playwright"]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\ndefault_tools_approval_mode = "approve"\n`, { mode: 0o600 });
  const options = { provider: "codex", name: "szpont_playwright", server, toolApproval: "approve", config: { codexHome, codexBin: "/usr/local/bin/codex" } };
  assert.equal((await inspectMcp(options)).status, "configured");
  assert.equal((await unregisterMcp(options)).status, "removed");
  assert.equal((await inspectMcp(options)).status, "missing");
  const currentPath = root.replace("/var/lib/szpont/", "/var/lib/plompy/");
  assert.equal(await readFile(join(currentPath, "codex/config.toml"), "utf8"), await readFile(configPath, "utf8"));
  console.log("PASS: legacy physical volume paths retain shared state, strict credential/browser guards and approved Playwright inspection/removal.");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
  await rm(credential, { force: true });
}
