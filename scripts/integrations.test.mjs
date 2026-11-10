import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import {
  createContext,
  integrationStatus,
  loginGitHub,
  runIntegrations,
} from "./integrations.mjs";
import { playbook } from "./integrations/catalog.mjs";
import { canonical } from "./integrations/paths.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "scripts/integrations.mjs");

async function fixture(t, runner = "claude") {
  const dir = await mkdtemp(join(tmpdir(), "szpont-integration-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, "workspace"),
    state = join(dir, "state"),
    publicRoot = join(dir, "public");
  for (const path of [
    workspace,
    join(workspace, "agent"),
    state,
    publicRoot,
    join(dir, "bin"),
  ])
    await mkdir(path, { mode: 0o700 });
  const env = {
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    HOME: dir,
    SZPONT_WORKSPACE: workspace,
    SZPONT_STATE_DIR: state,
    SZPONT_RUNNER: runner,
    SZPONT_CLAUDE_MCP_CONFIG: join(dir, "claude", "mcp.json"),
    SZPONT_OPENCODE_CONFIG: join(dir, "opencode", "provider.json"),
    DISCORD_BOT_TOKEN: "synthetic-discord-secret",
    GH_TOKEN: "synthetic-gh-secret",
    GITHUB_TOKEN: "synthetic-github-secret",
    UNRELATED_SECRET: "synthetic-other-secret",
  };
  const marker = join(dir, "gh-calls.jsonl");
  await writeFile(
    join(dir, "bin", "gh"),
    `#!${process.execPath}\nimport{appendFileSync}from'node:fs';
if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN||process.env.DISCORD_BOT_TOKEN||process.env.UNRELATED_SECRET)process.exit(91);
appendFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),gh:process.env.GH_CONFIG_DIR})+'\\n');
console.log('synthetic-gh-success');\n`,
    { mode: 0o700 },
  );
  const invoke = async (args) => {
    let text = "";
    await runIntegrations(args, {
      env,
      publicRoot,
      input: { isTTY: false },
      output: {
        isTTY: false,
        write: (v) => {
          text += v;
        },
      },
    });
    return text;
  };
  return { dir, workspace, state, publicRoot, env, marker, invoke };
}

test("catalog and help need no environment and exclude private integrations", async () => {
  let output = "";
  await runIntegrations(["list", "--json"], {
    env: {},
    output: { write: (v) => (output += v) },
  });
  const catalog = JSON.parse(output);
  assert.deepEqual(
    catalog.map((c) => c.id),
    [
      "github",
      "camoufox",
      "playwright",
      "perplexity",
      "firecrawl",
      "tinyfish",
      "posthog",
      "openai-docs",
      "context7",
      "custom",
    ],
  );
  assert.doesNotMatch(output, /doublecrawl|elevenlabs|drive/i);
});

test("non-TTY setup and unconfirmed mutation do not create configuration", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke([]), /TTY/);
  await assert.rejects(f.invoke(["add", "openai-docs"]), /No changes/);
  assert.deepEqual(await readdir(f.state), []);
  assert.deepEqual(await readdir(join(f.workspace, "agent")), []);
});

test("GitHub setup is isolated, idempotent and never starts login implicitly", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++)
    assert.match(await f.invoke(["add", "github", "--yes"]), /Configured/);
  const entries = JSON.parse(
    await readFile(join(f.state, "integrations.json"), "utf8"),
  ).integrations;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "github");
  const calls = (await readFile(f.marker, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(calls.every((c) => c.args.join(" ") === "--version"));
  const expectedGh = (await createContext(f.env, f.publicRoot)).config
    .githubConfigDir;
  assert.ok(calls.every((c) => c.gh === expectedGh));
  assert.equal((await lstat(join(f.dir, "github"))).mode & 0o777, 0o700);
  assert.equal(
    (await lstat(join(f.state, "integrations.json"))).mode & 0o777,
    0o600,
  );
  const instructions = await readFile(
    join(f.workspace, "agent", "INTEGRATIONS.md"),
    "utf8",
  );
  assert.match(instructions, /GitHub \(claude\)/);
  assert.match(instructions, /Git author identity/);
  assert.doesNotMatch(instructions, /synthetic-.*secret/);
  const status = JSON.parse(await f.invoke(["status", "github", "--json"]));
  assert.equal(status.integrations[0].status, "authenticated");
  assert.doesNotMatch(JSON.stringify(status), /synthetic-gh-success|secret/);
});

for (const runner of ["claude", "opencode"])
  test(`explicit ${runner} selection configures its default MCP file without changing the service default`, async (t) => {
    const f = await fixture(t, "codex");
    delete f.env.SZPONT_CLAUDE_MCP_CONFIG;
    delete f.env.SZPONT_OPENCODE_CONFIG;
    const result = await f.invoke([
      "add",
      "openai-docs",
      "--runner",
      runner,
      "--yes",
    ]);
    assert.match(result, new RegExp(`Runner: ${runner}`));
    assert.match(result, /existing threads keep their runner/);
    const path = join(f.dir, runner, "szpont-mcp.json");
    const document = JSON.parse(await readFile(path, "utf8"));
    const entry =
      document[runner === "claude" ? "mcpServers" : "mcp"].szpont_openai_docs;
    assert.equal(entry.url, "https://developers.openai.com/mcp");
    assert.equal(entry.type, runner === "claude" ? "http" : "remote");
    assert.equal(f.env.SZPONT_RUNNER, "codex");
    const selected = JSON.parse(
      await f.invoke(["status", "--runner", runner, "--json"]),
    );
    assert.equal(selected.provider, runner);
    assert.equal(selected.integrations[0].status, "configured");
    assert.equal(
      JSON.parse(await f.invoke(["status", "--json"])).integrations.length,
      0,
    );
    await f.invoke(["remove", "openai-docs", "--runner", runner, "--yes"]);
    assert.equal(
      JSON.parse(await f.invoke(["status", "--runner", runner, "--json"]))
        .integrations.length,
      0,
    );
  });

test("unsupported runners and unavailable container runners are rejected before writes", async (t) => {
  const f = await fixture(t, "codex");
  await assert.rejects(
    f.invoke(["add", "github", "--runner", "unknown-cli", "--yes"]),
    /Unsupported runner/,
  );
  f.env.SZPONT_CONTAINER_RUNNER = "codex";
  await assert.rejects(
    f.invoke(["add", "openai-docs", "--runner", "claude", "--yes"]),
    /container packages Codex only/,
  );
  assert.deepEqual(await readdir(f.state), []);
  assert.deepEqual(await readdir(join(f.workspace, "agent")), []);
});

test("configuration mismatch is preserved on add and remove", async (t) => {
  const f = await fixture(t);
  await f.invoke(["add", "openai-docs", "--yes"]);
  const json = JSON.parse(
    await readFile(f.env.SZPONT_CLAUDE_MCP_CONFIG, "utf8"),
  );
  json.mcpServers.szpont_openai_docs.url = "https://different.example/mcp";
  const bytes = JSON.stringify(json);
  await writeFile(f.env.SZPONT_CLAUDE_MCP_CONFIG, bytes, { mode: 0o600 });
  await assert.rejects(f.invoke(["add", "openai-docs", "--yes"]), /differs/);
  await assert.rejects(
    f.invoke(["remove", "openai-docs", "--yes"]),
    /differs|matches/,
  );
  assert.equal(await readFile(f.env.SZPONT_CLAUDE_MCP_CONFIG, "utf8"), bytes);
  assert.equal(
    JSON.parse(await f.invoke(["status", "--json"])).integrations[0].status,
    "conflict",
  );
});

for (const provider of ["claude", "opencode"])
  test(`remote documentation add/status/remove preserves unrelated ${provider} settings`, async (t) => {
    const f = await fixture(t, provider);
    const path =
      provider === "claude"
        ? f.env.SZPONT_CLAUDE_MCP_CONFIG
        : f.env.SZPONT_OPENCODE_CONFIG;
    await mkdir(dirname(path), { mode: 0o700 });
    const existing =
      provider === "claude"
        ? { mcpServers: { existing: { command: "/trusted/stdio", args: [] } } }
        : { provider: { example: { name: "preserve me" } }, mcp: {} };
    await writeFile(path, JSON.stringify(existing), { mode: 0o600 });
    await f.invoke(["add", "openai-docs", "--yes"]);
    await f.invoke(["add", "context7", "--yes"]);
    const status = JSON.parse(await f.invoke(["status", "--json"]));
    assert.equal(status.integrations.length, 2);
    assert.ok(status.integrations.every((e) => e.status === "configured"));
    assert.ok(status.integrations.every((e) => /not tested/.test(e.detail)));
    await f.invoke(["remove", "openai-docs", "--yes"]);
    await f.invoke(["remove", "context7", "--yes"]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), existing);
  });

test("operator instructions and symlinks fail before MCP configuration is changed", async (t) => {
  const f = await fixture(t);
  const path = join(f.workspace, "agent", "INTEGRATIONS.md");
  await writeFile(path, "# My own instructions\n", { mode: 0o600 });
  await assert.rejects(f.invoke(["add", "openai-docs", "--yes"]), /Preserve/);
  await assert.rejects(readFile(f.env.SZPONT_CLAUDE_MCP_CONFIG), /ENOENT/);
  await assert.rejects(readFile(join(f.state, "integrations.json")), /ENOENT/);
  await rm(path);
  await symlink(join(f.dir, "outside.md"), path);
  await assert.rejects(f.invoke(["add", "github", "--yes"]), /Preserve/);
  await assert.rejects(readFile(f.marker), /ENOENT/);
});

test("private state cannot point into source, workspace or symlink aliases", async (t) => {
  const f = await fixture(t);
  for (const state of [f.publicRoot, join(f.workspace, "state")])
    await assert.rejects(
      createContext({ ...f.env, SZPONT_STATE_DIR: state }, f.publicRoot),
      /overlap/,
    );
  await symlink(f.publicRoot, join(f.dir, "alias"));
  await assert.rejects(
    createContext(
      { ...f.env, GH_CONFIG_DIR: join(f.dir, "alias", "credentials") },
      f.publicRoot,
    ),
    /overlap/,
  );
});

test("GitHub credentials cannot be hidden inside directories denied to the runner", async (t) => {
  const f = await fixture(t);
  for (const location of [
    join(f.state, "github"),
    join(f.dir, "codex", "github"),
    join(f.dir, "claude", "github"),
    join(f.dir, "opencode"),
  ])
    await assert.rejects(
      createContext({ ...f.env, GH_CONFIG_DIR: location }, f.publicRoot),
      /dedicated directory/,
    );
});

test("CLI defaults match runtime lexical paths even through a state-directory alias", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.dir, "alternate"), { mode: 0o700 });
  await mkdir(join(f.dir, "alternate", "state"), { mode: 0o700 });
  await symlink(join(f.dir, "alternate", "state"), join(f.dir, "state-alias"));
  const ctx = await createContext(
    { ...f.env, SZPONT_STATE_DIR: join(f.dir, "state-alias") },
    f.publicRoot,
  );
  assert.ok(ctx.config.githubConfigDir.endsWith("/github"));
  assert.ok(!ctx.config.githubConfigDir.endsWith("/alternate/github"));
  assert.equal(
    ctx.config.browserDir,
    await canonical("/var/lib/szpont/browser"),
  );
});

test("status does not create missing state and hides failed authentication diagnostics", async (t) => {
  const f = await fixture(t);
  await rm(f.state, { recursive: true });
  assert.match(await f.invoke(["status"]), /No managed/);
  await assert.rejects(lstat(f.state), /ENOENT/);
  const ctx = await createContext(f.env, f.publicRoot);
  const result = await integrationStatus(ctx, { id: "github" }, async () => {
    throw new Error("synthetic-private-token");
  });
  assert.equal(result.status, "not_ready");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
});

test("custom MCP spec is explicit, private, and can be removed without changing other entries", async (t) => {
  const f = await fixture(t);
  const spec = join(f.dir, "trusted-server.json");
  await writeFile(
    spec,
    JSON.stringify({
      name: "szpont_team",
      server: { url: "https://docs.example/mcp" },
    }),
    { mode: 0o600 },
  );
  await f.invoke(["add", "custom", "--spec", spec, "--yes"]);
  assert.match(await f.invoke(["status", "custom"]), /configured/);
  await f.invoke(["remove", "custom", "--yes"]);
  assert.equal(
    JSON.parse(await f.invoke(["status", "--json"])).integrations.length,
    0,
  );
  await chmod(spec, 0o644);
  await assert.rejects(
    f.invoke(["add", "custom", "--spec", spec, "--yes"]),
    /unsafe/,
  );
});

test("setup lock prevents competing configuration and non-TTY login does not attempt authentication", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.state, "integrations.lock"), { mode: 0o700 });
  await assert.rejects(
    f.invoke(["add", "github", "--yes"]),
    /Another integration/,
  );
  await rm(join(f.state, "integrations.lock"), { recursive: true });
  await assert.rejects(
    f.invoke(["login", "github", "--yes"]),
    /requires a TTY/,
  );
  await assert.rejects(readFile(f.marker), /ENOENT/);
  assert.deepEqual(await readdir(f.state), []);
});

test("generated integration guidance explicitly scopes tools to the configured provider", () => {
  const text = playbook([
    { id: "context7", name: "szpont_context7", provider: "claude" },
  ]);
  assert.match(text, /only when the current thread uses claude/);
  assert.match(text, /Other runners do not inherit/);
});

test("GitHub login gets private writable Git configuration and no inherited tokens", async (t) => {
  const f = await fixture(t),
    ctx = await createContext(f.env, f.publicRoot);
  let called = false;
  await loginGitHub(ctx, (binary, args, options) => {
    called = true;
    assert.equal(binary, "gh");
    assert.ok(args.includes("--web"));
    assert.equal(options.stdio, "inherit");
    assert.equal(
      options.env.GIT_CONFIG_GLOBAL,
      join(ctx.config.githubConfigDir, "gitconfig"),
    );
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.equal(options.env.DISCORD_BOT_TOKEN, undefined);
    const event = new EventEmitter();
    queueMicrotask(() => event.emit("exit", 0));
    return event;
  });
  assert.ok(called);
  assert.equal(
    (await lstat(join(ctx.config.githubConfigDir, "gitconfig"))).mode & 0o777,
    0o600,
  );
});

test("CLI errors do not expose subprocess output", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.dir, "bin", "gh"),
    `#!${process.execPath}\nconsole.error('synthetic-private-token');process.exit(1);\n`,
    { mode: 0o700 },
  );
  const result = await execute(
    process.execPath,
    [cli, "add", "github", "--yes"],
    { env: f.env },
  ).catch((e) => e);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Install GitHub CLI/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private/);
});

for (const runner of ["claude", "opencode"])
  for (const [id, url] of [
    ["perplexity", "https://api.perplexity.ai/mcp"],
    ["firecrawl", "https://mcp.firecrawl.dev/v2/mcp-oauth"],
    ["tinyfish", "https://agent.tinyfish.ai/mcp"],
    ["posthog", "https://mcp.posthog.com/mcp?readonly=true"],
  ])
    test(`${id} OAuth configuration is isolated to ${runner} and removal preserves other services`, async (t) => {
      const f = await fixture(t, runner);
      await f.invoke(["add", "openai-docs", "--yes"]);
      await f.invoke(["add", id, "--yes"]);
      const path =
        runner === "claude"
          ? f.env.SZPONT_CLAUDE_MCP_CONFIG
          : f.env.SZPONT_OPENCODE_CONFIG;
      const config = JSON.parse(await readFile(path, "utf8"));
      const entry =
        config[runner === "claude" ? "mcpServers" : "mcp"]["szpont_" + id];
      assert.equal(entry.url, url);
      const status = JSON.parse(await f.invoke(["status", id, "--json"]));
      assert.equal(status.integrations[0].status, "configured");
      assert.match(status.integrations[0].detail, /not tested/);
      await f.invoke(["remove", id, "--yes"]);
      const remaining = JSON.parse(await f.invoke(["status", "--json"]));
      assert.deepEqual(
        remaining.integrations.map((e) => e.id),
        ["openai-docs"],
      );
    });

test("Firecrawl keyless is explicit and unsupported authentication never registers a server", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.invoke(["add", "tinyfish", "--auth", "keyless", "--yes"]),
    /auth|support|mode/i,
  );
  await assert.rejects(
    f.invoke(["add", "github", "--auth", "oauth", "--yes"]),
    /Authentication options/,
  );
  await assert.rejects(
    f.invoke(["add", "posthog", "--auth", "api-key", "--yes"]),
    /credential|file/i,
  );
  await f.invoke(["add", "firecrawl", "--auth", "keyless", "--yes"]);
  const value = JSON.parse(
    await readFile(f.env.SZPONT_CLAUDE_MCP_CONFIG, "utf8"),
  );
  assert.equal(
    value.mcpServers.szpont_firecrawl.url,
    "https://mcp.firecrawl.dev/v2/mcp",
  );
  assert.equal(Object.keys(value.mcpServers).length, 1);
});

test("new playbooks distinguish isolated browsing, external research and analytics access", () => {
  const text = playbook(
    ["playwright", "perplexity", "firecrawl", "tinyfish", "posthog"].map(
      (id) => ({ id, name: "szpont_" + id, provider: "opencode" }),
    ),
  );
  assert.match(text, /fresh isolated headless session/);
  assert.match(text, /read-only mode/);
  assert.match(text, /does not install a tracking SDK/);
  assert.match(text, /consumer subscription does not prove API entitlement/);
  assert.match(text, /Other runners do not inherit/);
});
