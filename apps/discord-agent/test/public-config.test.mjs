import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, authorized } from "../dist/config.js";
const env = {
  DISCORD_BOT_TOKEN: "synthetic-test-value",
  PLOMPY_DISCORD_GUILD_ID: "111111111111111111",
  PLOMPY_DISCORD_OWNER_ID: "222222222222222222",
  PLOMPY_DISCORD_BOT_ID: "333333333333333333",
  PLOMPY_DISCORD_PARENT_CHANNEL_ID: "444444444444444444",
  PLOMPY_WORKSPACE: "/tmp/private/workspace",
  PLOMPY_STATE_DIR: "/tmp/private/state",
  PLOMPY_ARTIFACTS_DIR: "/tmp/private/artifacts",
  CODEX_HOME: "/tmp/private/codex",
};
test("configuration requires each deployment identity with no owner fallback", () => {
  const config = loadConfig(env);
  assert.equal(config.guildId, "111111111111111111");
  assert.equal(config.ownerId, "222222222222222222");
  assert.equal(config.botId, "333333333333333333");
  for (const key of [
    "PLOMPY_DISCORD_GUILD_ID",
    "PLOMPY_DISCORD_OWNER_ID",
    "PLOMPY_DISCORD_BOT_ID",
  ]) {
    const missing = { ...env };
    delete missing[key];
    assert.throws(() => loadConfig(missing), /Missing/);
    for (const value of ["wrong", "123", " " + env[key], "", "0".repeat(21)])
      assert.throws(() => loadConfig({ ...env, [key]: value }));
  }
});
test("authorization follows the selected deployment and rejects another owner, guild or parent", () => {
  const config = loadConfig(env);
  const message = {
    id: "555555555555555555",
    channelId: "666666666666666666",
    guildId: config.guildId,
    authorId: config.ownerId,
    parentId: config.parentId,
    thread: true,
    bot: false,
    webhook: false,
    attachments: 0,
    content: "Build a local example",
  };
  assert.equal(authorized(message, config), true);
  for (const patch of [
    { guildId: "777777777777777777" },
    { authorId: "888888888888888888" },
    { parentId: "999999999999999999" },
    { bot: true },
    { webhook: true },
  ])
    assert.equal(authorized({ ...message, ...patch }, config), false);
  const other = { ...config, ownerId: "888888888888888888" };
  assert.equal(authorized(message, other), false);
  assert.equal(
    authorized({ ...message, authorId: other.ownerId }, other),
    true,
  );
});

async function managedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "plompy-managed-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureEnv = {
    ...env,
    PLOMPY_WORKSPACE: join(root, "workspace"),
    PLOMPY_STATE_DIR: join(root, "state"),
    PLOMPY_ARTIFACTS_DIR: join(root, "artifacts"),
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    PLOMPY_OPENCODE_HOME: join(root, "opencode"),
    PLOMPY_OPENCODE_MODEL: "synthetic/model",
  };
  await mkdir(fixtureEnv.CLAUDE_CONFIG_DIR, { mode: 0o700 });
  await mkdir(fixtureEnv.PLOMPY_OPENCODE_HOME, { mode: 0o700 });
  return { root, env: fixtureEnv };
}

test("only the fixed managed MCP filename is discovered, without creating missing files", async (t) => {
  const f = await managedFixture(t);
  await writeFile(join(f.env.CLAUDE_CONFIG_DIR, "settings.json"), "{}", {
    mode: 0o600,
  });
  await writeFile(join(f.env.PLOMPY_OPENCODE_HOME, "opencode.json"), "{}", {
    mode: 0o600,
  });
  const before = await readdir(f.root);
  const config = loadConfig(f.env);
  assert.equal(config.claudeMcpConfig, undefined);
  assert.equal(config.opencodeConfig, undefined);
  assert.deepEqual(await readdir(f.root), before);
  assert.deepEqual(await readdir(f.env.CLAUDE_CONFIG_DIR), ["settings.json"]);
  assert.deepEqual(await readdir(f.env.PLOMPY_OPENCODE_HOME), [
    "opencode.json",
  ]);
});

test("managed integrations are discovered for all persisted runners and explicit overrides win", async (t) => {
  const f = await managedFixture(t);
  const claude = join(f.env.CLAUDE_CONFIG_DIR, "plompy-mcp.json");
  const opencode = join(f.env.PLOMPY_OPENCODE_HOME, "plompy-mcp.json");
  await writeFile(claude, '{"mcpServers":{}}', { mode: 0o600 });
  await writeFile(opencode, '{"mcp":{}}', { mode: 0o600 });
  for (const provider of ["codex", "claude", "opencode"]) {
    const config = loadConfig({ ...f.env, PLOMPY_RUNNER: provider });
    assert.equal(config.claudeMcpConfig, claude);
    assert.equal(config.opencodeConfig, opencode);
  }
  await chmod(claude, 0o644);
  await chmod(opencode, 0o644);
  const config = loadConfig({
    ...f.env,
    PLOMPY_CLAUDE_MCP_CONFIG: join(f.root, "explicit-claude.json"),
    PLOMPY_OPENCODE_CONFIG: join(f.root, "explicit-opencode.json"),
  });
  assert.equal(config.claudeMcpConfig, join(f.root, "explicit-claude.json"));
  assert.equal(config.opencodeConfig, join(f.root, "explicit-opencode.json"));
});

for (const provider of ["claude", "opencode"]) {
  for (const kind of [
    "symlink",
    "hardlink",
    "directory",
    "permissions",
    "oversize",
  ]) {
    test(`${provider}: unsafe managed ${kind} fails configuration without exposing its contents`, async (t) => {
      const f = await managedFixture(t);
      const home =
        f.env[
          provider === "claude" ? "CLAUDE_CONFIG_DIR" : "PLOMPY_OPENCODE_HOME"
        ];
      const path = join(home, "plompy-mcp.json");
      const secret = "synthetic-private-file-contents";
      if (kind === "directory") await mkdir(path, { mode: 0o700 });
      else if (kind === "symlink" || kind === "hardlink") {
        const original = join(f.root, "operator.json");
        await writeFile(original, secret, { mode: 0o600 });
        await (kind === "symlink" ? symlink : link)(original, path);
      } else {
        await writeFile(
          path,
          kind === "oversize" ? " ".repeat(65_537) : secret,
          { mode: 0o600 },
        );
        if (kind === "permissions") await chmod(path, 0o644);
      }
      assert.throws(
        () => loadConfig(f.env),
        (error) => {
          assert.match(error.message, /Unsafe managed MCP configuration/);
          assert.equal(error.message.includes(secret), false);
          assert.equal(error.message.includes(f.root), false);
          return true;
        },
      );
    });
  }
}

test("pre-0.12 environments keep the same identities and state; explicit new settings win", () => {
  const legacy = Object.fromEntries(Object.entries(env).map(([key, value]) => [key.replace(/^PLOMPY_/, "SZPONT_"), value]));
  assert.deepEqual(loadConfig(legacy), loadConfig(env));
  assert.equal(loadConfig({ ...legacy, PLOMPY_STATE_DIR: "/tmp/new-private/state" }).stateDir, "/tmp/new-private/state");
  assert.throws(() => loadConfig({ ...legacy, PLOMPY_STATE_DIR: "" }), /Missing PLOMPY_STATE_DIR/);
  assert.equal(legacy.PLOMPY_STATE_DIR, undefined, "caller environment is not rewritten");
});

test("legacy managed MCP files are reused with safety checks and ambiguity fails closed", async (t) => {
  const f = await managedFixture(t);
  const legacy = join(f.env.CLAUDE_CONFIG_DIR, "szpont-mcp.json");
  const current = join(f.env.CLAUDE_CONFIG_DIR, "plompy-mcp.json");
  await writeFile(legacy, '{"mcpServers":{}}', { mode: 0o600 });
  assert.equal(loadConfig(f.env).claudeMcpConfig, legacy);
  await chmod(legacy, 0o644);
  assert.throws(() => loadConfig(f.env), /Unsafe managed MCP/);
  await chmod(legacy, 0o600);
  await writeFile(current, '{"mcpServers":{}}', { mode: 0o600 });
  assert.throws(() => loadConfig(f.env), /Both current and legacy/);
  assert.equal(loadConfig({ ...f.env, PLOMPY_CLAUDE_MCP_CONFIG: legacy }).claudeMcpConfig, legacy);
});
