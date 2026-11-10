import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { formatReport, runDoctor, runDiscordChecks } from "./doctor.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/doctor.mjs");
const secret = "synthetic-private-token-DO-NOT-DISCLOSE";
const requiredKeys = [
  "SZPONT_WORKSPACE",
  "SZPONT_STATE_DIR",
  "SZPONT_ARTIFACTS_DIR",
  "CODEX_HOME",
  "SZPONT_BROWSER_DIR",
];
const resultFor = (result, id) =>
  result.checks.find((check) => check.id === id);

async function fixture(
  t,
  { version = "codex-cli 0.166.0", loginCode = 0 } = {},
) {
  const temporary = await mkdtemp(join(tmpdir(), "szpont-doctor-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const publicRoot = join(temporary, "public-source");
  await mkdir(publicRoot);
  const paths = ["workspace", "state", "artifacts", "codex", "browser"].map(
    (part) => join(temporary, "private", part),
  );
  await Promise.all(
    paths.map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await execute("git", ["init", "--quiet"], {
    cwd: paths[0],
    env: {
      PATH: process.env.PATH,
      HOME: temporary,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const marker = join(temporary, "login-was-called");
  const binary = join(temporary, "fake-codex.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.env.DISCORD_BOT_TOKEN || process.env.GIT_DIR || process.env.UNRELATED_SECRET) {
  console.error(${JSON.stringify(secret)}); process.exit(91);
}
if (process.argv.slice(2).join(' ') === '--version') {
  console.log(${JSON.stringify(version)});
} else if (process.argv.slice(2).join(' ') === 'login status') {
  writeFileSync(${JSON.stringify(marker)}, 'explicit login check');
  console.log(${JSON.stringify(secret)});
  console.error(${JSON.stringify(temporary)});
  process.exit(${loginCode});
} else process.exit(92);
`,
    { mode: 0o700 },
  );
  const env = {
    PATH: process.env.PATH,
    HOME: temporary,
    DISCORD_BOT_TOKEN: secret,
    SZPONT_DISCORD_GUILD_ID: "111111111111111111",
    SZPONT_DISCORD_OWNER_ID: "222222222222222222",
    SZPONT_DISCORD_BOT_ID: "333333333333333333",
    SZPONT_DISCORD_PARENT_CHANNEL_ID: "444444444444444444",
    SZPONT_CODEX_BIN: binary,
    UNRELATED_SECRET: secret,
    GIT_DIR: join(publicRoot, "injected.git"),
    ...Object.fromEntries(
      requiredKeys.map((key, index) => [key, paths[index]]),
    ),
  };
  return {
    temporary,
    publicRoot,
    env,
    marker,
    inspect: (options = {}) => runDoctor({ env, publicRoot, ...options }),
  };
}

async function snapshot(path) {
  const value = await stat(path);
  if (!value.isDirectory())
    return [
      value.mode,
      value.size,
      value.mtimeMs,
      (await readFile(path)).toString("base64"),
    ];
  return [
    value.mode,
    value.mtimeMs,
    await Promise.all(
      (await readdir(path))
        .sort()
        .map(async (entry) => [entry, await snapshot(join(path, entry))]),
    ),
  ];
}

function assertPrivateOutput(result, data) {
  for (const output of [formatReport(result), formatReport(result, true)]) {
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes(data.temporary), false);
    assert.equal(output.includes(data.env.SZPONT_CODEX_BIN), false);
  }
}

test("healthy offline inspection passes, omits login and leaves deployment bytes, modes and modification times unchanged", async (t) => {
  const data = await fixture(t);
  const before = await snapshot(data.temporary);
  const result = await data.inspect({
    fetchImpl: () => assert.fail("Default doctor must remain offline"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks.map(({ id, status }) => [id, status]),
    [
      ["node_runtime", "PASS"],
      ["configuration", "PASS"],
      ["path_separation", "PASS"],
      ["private_directories", "PASS"],
      ["private_writability", "PASS"],
      ["workspace_git", "PASS"],
      ["codex_version", "PASS"],
      ["codex_login", "NOT_RUN"],
      ["discord_bot_identity", "NOT_RUN"],
      ["discord_guild_owner", "NOT_RUN"],
      ["discord_private_forum", "NOT_RUN"],
      ["discord_bot_permissions", "NOT_RUN"],
    ],
  );
  assert.deepEqual(await snapshot(data.temporary), before);
  assertPrivateOutput(result, data);
});

test("Node versions outside 24 are required failures", async (t) => {
  const data = await fixture(t);
  const result = await data.inspect({ nodeVersion: "22.15.0" });
  assert.equal(result.ok, false);
  assert.equal(resultFor(result, "node_runtime").status, "FAIL");
});

test("the compiled loader rejects missing identities without exposing values or invoking Codex", async (t) => {
  const data = await fixture(t);
  delete data.env.SZPONT_DISCORD_OWNER_ID;
  const result = await data.inspect({ checkLogin: true });
  assert.equal(result.ok, false);
  assert.equal(resultFor(result, "configuration").status, "FAIL");
  assert.equal(resultFor(result, "codex_version").status, "NOT_RUN");
  assert.equal(resultFor(result, "codex_login").status, "NOT_RUN");
  await assert.rejects(stat(data.marker), { code: "ENOENT" });
  assertPrivateOutput(result, data);
});

test("configuration validation retains the loader's identity and timeout constraints", async (t) => {
  const data = await fixture(t);
  for (const patch of [
    { SZPONT_DISCORD_GUILD_ID: "invalid" },
    { SZPONT_TASK_TIMEOUT_MS: "0" },
    { SZPONT_WORKSPACE: "relative-workspace" },
  ]) {
    const result = await runDoctor({
      env: { ...data.env, ...patch },
      publicRoot: data.publicRoot,
    });
    assert.equal(resultFor(result, "configuration").status, "FAIL");
    assert.equal(result.ok, false);
  }
});

test("missing private directories fail without creating directories, an SQLite database or auth files", async (t) => {
  const data = await fixture(t);
  const missing = join(data.temporary, "not-created", "state");
  data.env.SZPONT_STATE_DIR = missing;
  const before = await snapshot(data.temporary);
  const result = await data.inspect();
  assert.equal(resultFor(result, "path_separation").status, "PASS");
  assert.equal(resultFor(result, "private_directories").status, "FAIL");
  assert.equal(resultFor(result, "workspace_git").status, "NOT_RUN");
  assert.equal(result.ok, false);
  assert.deepEqual(await snapshot(data.temporary), before);
  await assert.rejects(stat(dirname(missing)), { code: "ENOENT" });
});

test("a file cannot masquerade as a private directory", async (t) => {
  const data = await fixture(t);
  const file = join(data.temporary, "not-a-directory");
  await writeFile(file, "synthetic");
  data.env.SZPONT_ARTIFACTS_DIR = file;
  const result = await data.inspect();
  assert.equal(resultFor(result, "private_directories").status, "FAIL");
  assert.equal(result.ok, false);
});

test("symlink aliases into public source are rejected even when the final destination is missing", async (t) => {
  const data = await fixture(t);
  const alias = join(data.temporary, "public-alias");
  await symlink(data.publicRoot, alias, "dir");
  data.env.CODEX_HOME = join(alias, "missing-private-home");
  const result = await data.inspect();
  assert.equal(resultFor(result, "path_separation").status, "FAIL");
  assert.equal(resultFor(result, "codex_version").status, "NOT_RUN");
  assertPrivateOutput(result, data);
});

test("public root aliases and private ancestors of source cannot bypass separation", async (t) => {
  const data = await fixture(t);
  const alias = join(data.temporary, "source-alias");
  await symlink(data.publicRoot, alias, "dir");
  data.env.SZPONT_BROWSER_DIR = data.temporary;
  const result = await data.inspect({ publicRoot: alias });
  assert.equal(resultFor(result, "path_separation").status, "FAIL");
});

test("overlapping private directories and relative browser paths are rejected", async (t) => {
  const data = await fixture(t);
  // Keep the optional integration directory independent while exercising the
  // doctor's existing state/workspace overlap check.
  data.env.GH_CONFIG_DIR = join(data.temporary, "private", "github");
  for (const value of [
    data.env.SZPONT_WORKSPACE,
    join(data.env.SZPONT_WORKSPACE, "state"),
  ]) {
    data.env.SZPONT_STATE_DIR = value;
    assert.equal(
      resultFor(await data.inspect(), "path_separation").status,
      "FAIL",
    );
  }
  data.env.SZPONT_STATE_DIR = join(data.temporary, "private", "state");
  data.env.SZPONT_BROWSER_DIR = "relative-browser";
  assert.equal(
    resultFor(await data.inspect(), "path_separation").status,
    "FAIL",
  );
});

test("different private directory names resolving to the same target are rejected", async (t) => {
  const data = await fixture(t);
  const alias = join(data.temporary, "state-alias");
  await symlink(data.env.SZPONT_STATE_DIR, alias, "dir");
  data.env.SZPONT_ARTIFACTS_DIR = alias;
  assert.equal(
    resultFor(await data.inspect(), "path_separation").status,
    "FAIL",
  );
});

test(
  "a read-only private directory fails the permission inspection without chmod or write probes",
  {
    skip:
      process.getuid?.() === 0 &&
      "root can bypass mode-based write permissions",
  },
  async (t) => {
    const data = await fixture(t);
    await chmod(data.env.SZPONT_STATE_DIR, 0o500);
    t.after(() => chmod(data.env.SZPONT_STATE_DIR, 0o700).catch(() => {}));
    const before = await stat(data.env.SZPONT_STATE_DIR);
    const result = await data.inspect();
    assert.equal(resultFor(result, "private_writability").status, "FAIL");
    assert.equal(result.ok, false);
    const after = await stat(data.env.SZPONT_STATE_DIR);
    assert.equal(after.mode, before.mode);
    assert.equal(after.mtimeMs, before.mtimeMs);
  },
);

test("an inherited parent Git repository is not accepted as an initialized workspace", async (t) => {
  const data = await fixture(t);
  const nested = join(data.env.SZPONT_WORKSPACE, "nested");
  await mkdir(nested);
  data.env.SZPONT_WORKSPACE = nested;
  assert.equal(resultFor(await data.inspect(), "workspace_git").status, "FAIL");
});

test("Git metadata cannot be a symlink back into public source", async (t) => {
  const data = await fixture(t);
  const metadata = join(data.env.SZPONT_WORKSPACE, ".git");
  const publicMetadata = join(data.publicRoot, "public.git");
  const { rename } = await import("node:fs/promises");
  await rename(metadata, publicMetadata);
  await symlink(publicMetadata, metadata, "dir");
  const result = await data.inspect();
  assert.equal(resultFor(result, "workspace_git").status, "FAIL");
  assertPrivateOutput(result, data);
});

test("a mismatched or unexpected CLI response fails without echoing stdout or stderr", async (t) => {
  for (const version of [
    "codex-cli 0.165.0",
    `${secret} /private/synthetic/account`,
  ]) {
    const data = await fixture(t, { version });
    const result = await data.inspect({ checkLogin: true });
    assert.equal(resultFor(result, "codex_version").status, "FAIL");
    assert.equal(resultFor(result, "codex_login").status, "NOT_RUN");
    assert.equal(result.ok, false);
    assertPrivateOutput(result, data);
    await assert.rejects(stat(data.marker), { code: "ENOENT" });
  }
});

test("an unavailable Codex executable produces a fixed failure rather than raw process errors", async (t) => {
  const data = await fixture(t);
  data.env.SZPONT_CODEX_BIN = join(data.temporary, secret);
  const result = await data.inspect();
  assert.equal(resultFor(result, "codex_version").status, "FAIL");
  assert.equal(result.ok, false);
  assertPrivateOutput(result, data);
});

test("login status runs only after explicit opt-in and consumes no unfiltered parent secrets", async (t) => {
  const data = await fixture(t);
  const result = await data.inspect({ checkLogin: true });
  assert.equal(resultFor(result, "codex_login").status, "PASS");
  assert.equal(result.ok, true);
  assert.equal(await readFile(data.marker, "utf8"), "explicit login check");
  assertPrivateOutput(result, data);
});

test("an explicitly requested login failure is required and its output remains private", async (t) => {
  const data = await fixture(t, { loginCode: 1 });
  const result = await data.inspect({ checkLogin: true });
  assert.equal(resultFor(result, "codex_login").status, "FAIL");
  assert.equal(resultFor(result, "codex_login").required, true);
  assert.equal(result.ok, false);
  assertPrivateOutput(result, data);
});

test("CLI JSON is parseable, uses the real compiled loader and exits nonzero for required failures", async (t) => {
  const data = await fixture(t);
  const healthy = await execute(process.execPath, [script, "--json"], {
    env: data.env,
  });
  const result = JSON.parse(healthy.stdout);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, true);
  assert.equal(healthy.stderr, "");
  assertPrivateOutput(result, data);
  delete data.env.DISCORD_BOT_TOKEN;
  await assert.rejects(
    execute(process.execPath, [script, "--json"], { env: data.env }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).ok, false);
      assert.equal(error.stderr, "");
      return true;
    },
  );
});

test("an unbuilt checkout produces a fixed configuration failure without loading source or creating dist", async (t) => {
  const data = await fixture(t);
  const copied = join(data.publicRoot, "scripts", "doctor.mjs");
  await mkdir(dirname(copied));
  await copyFile(script, copied);
  await assert.rejects(
    execute(process.execPath, [copied, "--json"], { env: data.env }),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(resultFor(result, "configuration").status, "FAIL");
      assertPrivateOutput(result, data);
      return true;
    },
  );
  await assert.rejects(stat(resolve(dirname(copied), "../apps")), {
    code: "ENOENT",
  });
});

test("invalid flags are rejected without echoing untrusted argument values", async () => {
  await assert.rejects(
    execute(process.execPath, [script, "--json", secret]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).checks[0].id, "arguments");
      assert.equal(error.stdout.includes(secret), false);
      assert.equal(error.stderr, "");
      return true;
    },
  );
});

test("Claude diagnostics inspect the selected private home without requiring an unrelated Codex directory", async (t) => {
  const data = await fixture(t, { version: "2.1.285 (Claude Code)" });
  const home = join(data.temporary, "private", "claude");
  await mkdir(home);
  const env = {
    ...data.env,
    SZPONT_RUNNER: "claude",
    CLAUDE_CONFIG_DIR: home,
    SZPONT_CLAUDE_BIN: data.env.SZPONT_CODEX_BIN,
  };
  delete env.CODEX_HOME;
  const result = await runDoctor({ env, publicRoot: data.publicRoot });
  assert.equal(result.ok, true);
  assert.equal(resultFor(result, "claude_version").status, "PASS");
  assert.equal(resultFor(result, "claude_login").status, "NOT_RUN");
  assert.equal(resultFor(result, "codex_version"), undefined);
  await assert.rejects(stat(data.marker), { code: "ENOENT" });
  assertPrivateOutput(result, data);
});

test("OpenCode diagnostics require explicit host execution and distinguish local readiness from remote auth", async (t) => {
  const data = await fixture(t, { version: "1.19.5" });
  const home = join(data.temporary, "private", "opencode");
  await mkdir(home);
  const env = {
    ...data.env,
    SZPONT_RUNNER: "opencode",
    SZPONT_OPENCODE_HOME: home,
    SZPONT_OPENCODE_MODEL: "synthetic-provider/synthetic-model",
    SZPONT_OPENCODE_BIN: data.env.SZPONT_CODEX_BIN,
  };
  delete env.CODEX_HOME;
  const blocked = await runDoctor({ env, publicRoot: data.publicRoot });
  assert.equal(blocked.ok, false);
  assert.equal(resultFor(blocked, "opencode_host_execution").status, "FAIL");
  env.SZPONT_OPENCODE_HOST_EXECUTION = "allow";
  await mkdir(join(home, "data", "opencode"), { recursive: true });
  await writeFile(
    join(home, "data", "opencode", "auth.json"),
    JSON.stringify({
      "synthetic-provider": { type: "api", key: "synthetic-private-key" },
    }),
  );
  const ready = await runDoctor({
    env,
    publicRoot: data.publicRoot,
    checkLogin: true,
  });
  assert.equal(ready.ok, true);
  assert.equal(resultFor(ready, "opencode_login").status, "PASS");
  assert.match(
    resultFor(ready, "opencode_login").message,
    /remote authorization and model access were not tested/,
  );
  assertPrivateOutput(ready, data);
});

const discordConfig = {
  token: secret,
  guildId: "111111111111111111",
  ownerId: "222222222222222222",
  botId: "333333333333333333",
  parentId: "444444444444444444",
};
const botRole = "555555555555555555";
const anotherRole = "666666666666666666";
const view = 1n << 10n;
const attach = 1n << 15n;
const history = 1n << 16n;
const threadReply = 1n << 38n;
const requiredDiscordPermissions = view | attach | history | threadReply;
const discordCheckIds = [
  "discord_bot_identity",
  "discord_guild_owner",
  "discord_private_forum",
  "discord_bot_permissions",
];

function discordFixture() {
  const { botId, guildId, ownerId, parentId } = discordConfig;
  const paths = [
    "/users/@me",
    `/guilds/${guildId}`,
    `/channels/${parentId}`,
    `/guilds/${guildId}/members/${botId}`,
  ];
  const payloads = [
    { id: botId, bot: true },
    {
      id: guildId,
      owner_id: ownerId,
      roles: [
        { id: guildId, permissions: String(requiredDiscordPermissions) },
        { id: botRole, permissions: "0" },
        { id: anotherRole, permissions: "0" },
      ],
    },
    {
      id: parentId,
      type: 15,
      guild_id: guildId,
      permission_overwrites: [
        { id: guildId, type: 0, allow: "0", deny: String(view) },
        { id: botId, type: 1, allow: String(view), deny: "0" },
      ],
    },
    { user: { id: botId }, roles: [botRole] },
  ];
  const calls = [];
  const fetchImpl = async (url, options) => {
    const index = calls.length;
    calls.push({ url, options });
    assert.equal(url, `https://discord.com/api/v10${paths[index]}`);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bot ${secret}`);
    assert.equal(options.headers.Accept, "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    return Response.json(payloads[index]);
  };
  return {
    paths,
    payloads,
    calls,
    fetchImpl,
    inspect: (options = {}) =>
      runDiscordChecks({
        config: discordConfig,
        enabled: true,
        fetchImpl,
        ...options,
      }),
  };
}

function assertDiscordPrivate(checks) {
  for (const rendered of [JSON.stringify(checks), formatReport({ checks })]) {
    for (const value of [
      secret,
      ...Object.values(discordConfig).filter((x) => x !== secret),
      botRole,
      anotherRole,
      "https://discord.com",
      "PRIVATE_DISCORD_BODY",
    ])
      assert.equal(
        rendered.includes(value),
        false,
        "Discord diagnostics must stay sanitized",
      );
  }
}

test("Discord opt-in checks use only four fixed GET reads and do not modify deployment state", async (t) => {
  const data = await fixture(t);
  const network = discordFixture();
  const before = await snapshot(data.temporary);
  const result = await data.inspect({
    checkDiscord: true,
    fetchImpl: network.fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(network.calls.length, 4);
  assert.deepEqual(
    result.checks
      .filter((c) => c.id.startsWith("discord_"))
      .map(({ id, status, required }) => [id, status, required]),
    discordCheckIds.map((id) => [id, "PASS", true]),
  );
  assert.equal(resultFor(result, "codex_login").status, "NOT_RUN");
  assert.deepEqual(await snapshot(data.temporary), before);
  assertDiscordPrivate(result.checks);
  assertPrivateOutput(result, data);
});

test("Discord and login opt-ins can run together without changing their independent contracts", async (t) => {
  const data = await fixture(t);
  const network = discordFixture();
  const result = await data.inspect({
    checkDiscord: true,
    checkLogin: true,
    fetchImpl: network.fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(resultFor(result, "codex_login").status, "PASS");
  assert.equal(await readFile(data.marker, "utf8"), "explicit login check");
  assert.equal(network.calls.length, 4);
  assertDiscordPrivate(result.checks);
});

test("invalid local configuration never sends the token to Discord", async (t) => {
  const data = await fixture(t);
  delete data.env.SZPONT_DISCORD_GUILD_ID;
  const result = await data.inspect({
    checkDiscord: true,
    fetchImpl: () =>
      assert.fail("invalid configuration must not make a request"),
  });
  assert.equal(result.ok, false);
  for (const id of discordCheckIds) {
    assert.equal(resultFor(result, id).status, "NOT_RUN");
    assert.equal(resultFor(result, id).required, true);
  }
});

test("explicit Discord reads remain separate from unrelated missing local directories", async (t) => {
  const data = await fixture(t);
  data.env.SZPONT_STATE_DIR = join(data.temporary, "absent-state");
  const network = discordFixture();
  const result = await data.inspect({
    checkDiscord: true,
    fetchImpl: network.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(resultFor(result, "private_directories").status, "FAIL");
  assert.equal(resultFor(result, "discord_bot_permissions").status, "PASS");
  assert.equal(network.calls.length, 4);
});

test("wrong bot identity, non-bot tokens and guild owner mismatch stop dependent REST reads", async () => {
  for (const [index, patch] of [
    [0, { id: "999999999999999999" }],
    [0, { bot: false }],
    [1, { owner_id: "999999999999999999" }],
    [1, { id: "999999999999999999" }],
  ]) {
    const data = discordFixture();
    Object.assign(data.payloads[index], patch);
    const checks = await data.inspect();
    assert.equal(checks[index].status, "FAIL");
    assert.ok(checks.slice(index + 1).every((c) => c.status === "NOT_RUN"));
    assert.equal(data.calls.length, index + 1);
    assertDiscordPrivate(checks);
  }
});

test("startup privacy rejects wrong channel type or guild, public access and additional explicit readers", async () => {
  const changes = [
    (p) => (p[2].type = 0),
    (p) => (p[2].guild_id = "999999999999999999"),
    (p) => (p[2].id = "999999999999999999"),
    (p) => (p[2].permission_overwrites[0].deny = "0"),
    (p) => (p[2].permission_overwrites[0].allow = String(view)),
    (p) => (p[1].roles[0].permissions = "8"), // Administrator bypasses a deny.
    (p) =>
      p[2].permission_overwrites.push({
        id: anotherRole,
        type: 0,
        allow: String(view),
        deny: "0",
      }),
    (p) =>
      p[2].permission_overwrites.push({
        id: "999999999999999999",
        type: 1,
        allow: String(view),
        deny: String(view),
      }),
  ];
  for (const change of changes) {
    const data = discordFixture();
    change(data.payloads);
    const checks = await data.inspect();
    assert.equal(checks[2].status, "FAIL");
    assert.equal(checks[3].status, "NOT_RUN");
    assert.equal(data.calls.length, 3);
    assertDiscordPrivate(checks);
  }
});

test("REST forum privacy matches the actual startup validator and installed Discord role-permission resolver", async () => {
  const require = createRequire(
    new URL("../apps/discord-agent/package.json", import.meta.url),
  );
  const {
    Collection,
    GuildChannel,
    PermissionsBitField,
  } = require("discord.js");
  const { DiscordTransport } = await import(
    "../apps/discord-agent/dist/discord.js"
  );
  const variations = [
    () => {},
    (p) => (p[1].roles[0].permissions = "8"),
    (p) => (p[2].permission_overwrites[0].deny = "0"),
    (p) => (p[2].permission_overwrites[0].allow = String(view)),
    (p) => (p[2].permission_overwrites[1].allow = "0"),
    (p) =>
      p[2].permission_overwrites.push({
        id: discordConfig.ownerId,
        type: 1,
        allow: String(view),
        deny: "0",
      }),
    (p) =>
      p[2].permission_overwrites.push({
        id: anotherRole,
        type: 0,
        allow: String(view),
        deny: "0",
      }),
    (p) =>
      p[2].permission_overwrites.push({
        id: anotherRole,
        type: 0,
        allow: "0",
        deny: String(view),
      }),
  ];
  for (const change of variations) {
    const data = discordFixture();
    change(data.payloads);
    const guild = {
      id: discordConfig.guildId,
      ownerId: discordConfig.ownerId,
      roles: {},
    };
    const everyone = {
      id: guild.id,
      guild,
      permissions: new PermissionsBitField(
        data.payloads[1].roles[0].permissions,
      ),
    };
    guild.roles.everyone = everyone;
    const forum = {
      type: data.payloads[2].type,
      guildId: data.payloads[2].guild_id,
      guild,
      permissionOverwrites: {
        cache: new Collection(
          data.payloads[2].permission_overwrites.map((o) => [
            o.id,
            {
              ...o,
              allow: new PermissionsBitField(o.allow),
              deny: new PermissionsBitField(o.deny),
            },
          ]),
        ),
      },
      permissionsFor(role) {
        return GuildChannel.prototype.rolePermissions.call(this, role, true);
      },
    };
    let startupPassed = true;
    try {
      await DiscordTransport.prototype.validate.call({
        config: discordConfig,
        client: {
          user: { id: discordConfig.botId },
          guilds: { fetch: async () => guild },
          channels: { fetch: async () => forum },
        },
      });
    } catch {
      startupPassed = false;
    }
    const checks = await data.inspect();
    assert.equal(checks[2].status === "PASS", startupPassed);
  }
});

test("each required bot permission is checked with BigInt including the thread bit above 32 bits", async () => {
  for (const permission of [view, attach, history, threadReply]) {
    const data = discordFixture();
    data.payloads[1].roles[0].permissions = String(
      requiredDiscordPermissions & ~permission,
    );
    if (permission === view)
      data.payloads[2].permission_overwrites[1].allow = "0";
    const checks = await data.inspect();
    assert.equal(checks[2].status, "PASS");
    assert.equal(checks[3].status, "FAIL");
    assert.equal(data.calls.length, 4);
  }
});

test("effective bot permissions follow everyone, aggregated role, member and administrator precedence", async () => {
  for (const memberDeny of [false, true]) {
    const data = discordFixture();
    data.payloads[1].roles[0].permissions = String(
      requiredDiscordPermissions & ~attach,
    );
    data.payloads[2].permission_overwrites.push(
      { id: botRole, type: 0, allow: "0", deny: String(attach) },
      { id: anotherRole, type: 0, allow: String(attach), deny: "0" },
    );
    data.payloads[3].roles.push(anotherRole);
    if (memberDeny)
      data.payloads[2].permission_overwrites[1].deny = String(attach);
    const checks = await data.inspect();
    assert.equal(checks[3].status, memberDeny ? "FAIL" : "PASS");
  }
  const admin = discordFixture();
  admin.payloads[1].roles[0].permissions = "0";
  admin.payloads[1].roles[1].permissions = "8";
  assert.equal((await admin.inspect())[3].status, "PASS");
});

test("malformed permission/member objects fail closed without exposing returned values", async () => {
  for (const change of [
    (p) => (p[1].roles = null),
    (p) => (p[1].roles[0].permissions = -1),
    (p) => (p[1].roles[0].permissions = "9".repeat(33)),
    (p) => (p[2].permission_overwrites[0].deny = "PRIVATE_DISCORD_BODY"),
    (p) => (p[2].permission_overwrites[0].type = 2),
    (p) => p[2].permission_overwrites.push(p[2].permission_overwrites[0]),
    (p) => (p[3].roles = ["999999999999999999"]),
    (p) => (p[3].user.id = "999999999999999999"),
  ]) {
    const data = discordFixture();
    change(data.payloads);
    const checks = await data.inspect();
    assert.ok(checks.some((c) => c.status === "FAIL"));
    assertDiscordPrivate(checks);
  }
});

test("authorization, missing resources, rate limits and server failures never read error bodies or retry", async () => {
  for (const status of [301, 401, 403, 404, 429, 500, 503]) {
    let calls = 0,
      cancelled = false;
    const checks = await runDiscordChecks({
      config: discordConfig,
      enabled: true,
      fetchImpl: async () => {
        calls++;
        return {
          status,
          body: {
            cancel: async () => {
              cancelled = true;
            },
            getReader: () =>
              assert.fail("error response body must not be read"),
          },
        };
      },
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(checks[0].status, "FAIL");
    assert.ok(checks.slice(1).every((c) => c.status === "NOT_RUN"));
    assertDiscordPrivate(checks);
  }
});

test("raw transport errors and malformed UTF-8/JSON stay private", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error(
        `${secret} https://discord.com PRIVATE_DISCORD_BODY ${discordConfig.botId}`,
      );
    },
    async () => new Response(`PRIVATE_DISCORD_BODY ${secret}`),
    async () => new Response(new Uint8Array([0xff])),
    async () => Response.json(null),
  ]) {
    const checks = await runDiscordChecks({
      config: discordConfig,
      enabled: true,
      fetchImpl,
    });
    assert.equal(checks[0].status, "FAIL");
    assertDiscordPrivate(checks);
  }
});

test("response byte limits reject both declared and streamed overflow before interpreting private bodies", async () => {
  for (const declared of [false, true]) {
    let pulls = 0,
      cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(600_000).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    });
    const checks = await runDiscordChecks({
      config: discordConfig,
      enabled: true,
      fetchImpl: async () =>
        new Response(
          body,
          declared
            ? {
                headers: { "content-length": "1048577" },
              }
            : undefined,
        ),
    });
    assert.equal(checks[0].status, "FAIL");
    assert.equal(cancelled, true);
    assert.ok(pulls <= 3, "overflow must stop retaining or reading chunks");
    assertDiscordPrivate(checks);
  }
});

test("timeouts bound an unresponsive fetch and an unresponsive response body without retrying", async () => {
  for (const stalledBody of [false, true]) {
    let calls = 0,
      aborted = false,
      cancelled = false;
    const checks = await runDiscordChecks({
      config: discordConfig,
      enabled: true,
      requestTimeoutMs: 10,
      fetchImpl: async (_url, { signal }) => {
        calls++;
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        if (!stalledBody) return new Promise(() => {});
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    assert.equal(calls, 1);
    assert.equal(aborted, true);
    assert.equal(checks[0].status, "FAIL");
    if (stalledBody) assert.equal(cancelled, true);
    assertDiscordPrivate(checks);
  }
});

test("the overall Discord deadline bounds a sequence of otherwise responsive reads", async () => {
  const data = discordFixture();
  const checks = await data.inspect({
    totalTimeoutMs: 20,
    requestTimeoutMs: 100,
    fetchImpl: async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 12));
      return data.fetchImpl(...args);
    },
  });
  assert.ok(checks.some((c) => c.status === "FAIL"));
  assert.ok(data.calls.length <= 2);
  assertDiscordPrivate(checks);
});

test("CLI exposes Discord opt-in in help but help never makes a network request", async () => {
  const { stdout, stderr } = await execute(
    process.execPath,
    [script, "--help", "--check-discord", "--check-login", "--json"],
    { env: { PATH: process.env.PATH } },
  );
  assert.match(stdout, /--check-discord/);
  assert.match(stdout, /read-only Discord REST/);
  assert.equal(stderr, "");
});
