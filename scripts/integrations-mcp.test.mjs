import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
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
import { join } from "node:path";
import { inspectMcp, registerMcp, unregisterMcp } from "./integrations/mcp.mjs";

const secret = "SYNTHETIC-SECRET-MUST-NOT-APPEAR";
const remote = { url: "https://docs.example.test/mcp" };

async function fixture(t, provider = "claude") {
  const directory = await mkdtemp(join(tmpdir(), "szpont-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicRoot = join(directory, "public");
  const privateRoot = join(directory, "private");
  await mkdir(publicRoot, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  const codexHome = join(privateRoot, "codex");
  await mkdir(codexHome, { mode: 0o700 });
  const config = {
    publicRoot,
    codexHome,
    codexBin: "synthetic-codex",
    claudeMcpConfig: join(privateRoot, "claude-mcp.json"),
    opencodeConfig: join(privateRoot, "opencode.json"),
  };
  const options = { provider, config, name: "szpont_docs", server: remote };
  return {
    directory,
    publicRoot,
    privateRoot,
    config,
    options,
    path:
      provider === "opencode" ? config.opencodeConfig : config.claudeMcpConfig,
  };
}

function codexFake() {
  let entry = null;
  const calls = [];
  const execute = async (binary, args, options) => {
    calls.push({ binary, args, options });
    const [, operation, name] = args;
    if (operation === "get") {
      if (!entry) {
        let content = "";
        try {
          content = await readFile(
            join(options.env.CODEX_HOME, "config.toml"),
            "utf8",
          );
        } catch {}
        const found = content.match(
          /\[mcp_servers\."szpont_docs"\]\nurl = ("[^\n]+")/,
        );
        if (found)
          return {
            stdout: JSON.stringify({
              name,
              enabled: true,
              transport: { type: "streamable_http", url: JSON.parse(found[1]) },
            }),
          };
      }
      if (!entry)
        throw Object.assign(new Error(secret), {
          code: 1,
          stderr: `Error: No MCP server named '${name}' found.\n`,
        });
      return { stdout: JSON.stringify(entry), stderr: "" };
    }
    if (operation === "remove") {
      entry = null;
      const path = join(options.env.CODEX_HOME, "config.toml");
      try {
        const content = await readFile(path, "utf8");
        await writeFile(
          path,
          content.replace(
            /\n\[mcp_servers\."szpont_docs"\]\nurl = "[^\n]+"\n/,
            "",
          ),
        );
      } catch {}
      return { stdout: secret };
    }
    if (operation === "add") {
      const urlIndex = args.indexOf("--url");
      const separator = args.indexOf("--");
      const variables = {};
      for (let index = 3; index < args.length; index++)
        if (args[index] === "--env") {
          const value = args[++index],
            equal = value.indexOf("=");
          variables[value.slice(0, equal)] = value.slice(equal + 1);
        }
      entry = {
        name,
        enabled: true,
        disabled_reason: null,
        transport:
          urlIndex >= 0
            ? {
                type: "streamable_http",
                url: args[urlIndex + 1],
                bearer_token_env_var: null,
                http_headers: null,
                env_http_headers: null,
              }
            : {
                type: "stdio",
                command: args[separator + 1],
                args: args.slice(separator + 2),
                env: variables,
                env_vars: [],
                cwd: null,
              },
        enabled_tools: null,
        disabled_tools: null,
        startup_timeout_sec: null,
        tool_timeout_sec: null,
      };
      return { stdout: secret, stderr: secret };
    }
    throw new Error("Unexpected fake command");
  };
  return {
    execute,
    calls,
    set: (value) => {
      entry = value;
    },
    get: () => entry,
  };
}

for (const provider of ["claude", "opencode"]) {
  test(`${provider}: register, inspect, idempotence and removal preserve unrelated configuration`, async (t) => {
    const f = await fixture(t, provider);
    const key = provider === "claude" ? "mcpServers" : "mcp";
    const before = {
      provider: { synthetic: { apiKey: secret } },
      [key]: {
        existing: { type: "remote", url: "https://other.example.test/mcp" },
      },
    };
    await writeFile(f.path, JSON.stringify(before), { mode: 0o600 });
    const registered = await registerMcp(f.options);
    assert.deepEqual(registered, {
      provider,
      name: "szpont_docs",
      status: "configured",
      changed: true,
    });
    const actual = JSON.parse(await readFile(f.path, "utf8"));
    assert.deepEqual(actual.provider, before.provider);
    assert.deepEqual(actual[key].existing, before[key].existing);
    assert.deepEqual(
      actual[key].szpont_docs,
      provider === "claude"
        ? { type: "http", url: remote.url }
        : { type: "remote", url: remote.url, enabled: true },
    );
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    const snapshot = await readFile(f.path, "utf8");
    assert.equal((await inspectMcp(f.options)).status, "configured");
    assert.equal((await registerMcp(f.options)).changed, false);
    assert.equal(await readFile(f.path, "utf8"), snapshot);
    assert.deepEqual(await unregisterMcp(f.options), {
      provider,
      name: "szpont_docs",
      status: "removed",
      changed: true,
    });
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), before);
    assert.equal((await unregisterMcp(f.options)).status, "missing");
    assert.equal(JSON.stringify(registered).includes(secret), false);
    assert.deepEqual(
      (await readdir(f.privateRoot)).sort(),
      [
        provider === "claude" ? "claude-mcp.json" : "opencode.json",
        "codex",
      ].sort(),
    );
  });

  test(`${provider}: local Camoufox uses the provider's stdio shape`, async (t) => {
    const f = await fixture(t, provider);
    const env = {
      SZPONT_BROWSER_PROFILE: join(f.privateRoot, "profile"),
      SZPONT_BROWSER_ARTIFACTS: join(f.privateRoot, "artifacts"),
      CAMOUFOX_EXECUTABLE_PATH: join(f.privateRoot, "browser-bin"),
      DISPLAY: ":99",
    };
    const server = {
      command: "/usr/bin/python3",
      args: ["-m", "szpont_browser"],
      env,
    };
    await registerMcp({ ...f.options, server });
    const actual = JSON.parse(await readFile(f.path, "utf8"));
    assert.deepEqual(
      actual[provider === "claude" ? "mcpServers" : "mcp"].szpont_docs,
      provider === "claude"
        ? { type: "stdio", ...server }
        : {
            type: "local",
            command: [server.command, ...server.args],
            enabled: true,
            environment: env,
          },
    );
  });

  test(`${provider}: existing differing entry is preserved on install and remove`, async (t) => {
    const f = await fixture(t, provider);
    const bytes = JSON.stringify({
      [provider === "claude" ? "mcpServers" : "mcp"]: {
        szpont_docs: {
          url: "https://changed.example.test/mcp",
          headers: { Authorization: secret },
        },
      },
    });
    await writeFile(f.path, bytes, { mode: 0o600 });
    assert.equal((await inspectMcp(f.options)).status, "conflict");
    await assert.rejects(registerMcp(f.options), /preserved/);
    await assert.rejects(unregisterMcp(f.options), /preserved/);
    assert.equal(await readFile(f.path, "utf8"), bytes);
  });

  test(`${provider}: explicit private JSON path is required`, async (t) => {
    const f = await fixture(t, provider);
    await assert.rejects(
      registerMcp({ ...f.options, config: { publicRoot: f.publicRoot } }),
      new RegExp(
        provider === "claude"
          ? "SZPONT_CLAUDE_MCP_CONFIG"
          : "SZPONT_OPENCODE_CONFIG",
      ),
    );
  });
}

test("inspection of a missing JSON file creates no files or directories", async (t) => {
  const f = await fixture(t);
  f.config.claudeMcpConfig = join(f.privateRoot, "not-created", "config.json");
  assert.equal((await inspectMcp(f.options)).status, "missing");
  assert.deepEqual(await readdir(f.privateRoot), ["codex"]);
});

for (const [label, bytes] of [
  ["malformed", `{${secret}`],
  ["array", "[]"],
  ["invalid collection", '{"mcpServers": []}'],
]) {
  test(`${label} private JSON is never replaced`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.path, bytes, { mode: 0o600 });
    await assert.rejects(
      registerMcp(f.options),
      (error) => !error.message.includes(secret),
    );
    assert.equal(await readFile(f.path, "utf8"), bytes);
    assert.equal(
      (await readdir(f.privateRoot)).some(
        (name) => name.includes(".tmp") || name.includes(".lock"),
      ),
      false,
    );
  });
}

test("symlink and hardlink configuration files are refused without changing targets", async (t) => {
  const f = await fixture(t);
  const target = join(f.privateRoot, "original.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, f.path);
  await assert.rejects(registerMcp(f.options), /symlink/);
  await rm(f.path);
  await link(target, f.path);
  await assert.rejects(registerMcp(f.options), /hardlink/);
  assert.equal(await readFile(target, "utf8"), "{}");
});

test("public-source and symlink aliases into source are refused before any writes", async (t) => {
  const f = await fixture(t);
  f.config.claudeMcpConfig = join(f.publicRoot, "config.json");
  await assert.rejects(registerMcp(f.options), /public source/);
  const alias = join(f.privateRoot, "alias");
  await symlink(f.publicRoot, alias);
  f.config.claudeMcpConfig = join(alias, "config.json");
  await assert.rejects(registerMcp(f.options), /public source/);
  assert.deepEqual(await readdir(f.publicRoot), []);
});

test("insecure existing JSON and insecure private parent are refused", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, "{}", { mode: 0o644 });
  // Creation modes are masked by the caller's umask; this fixture must be insecure.
  await chmod(f.path, 0o644);
  assert.equal((await stat(f.path)).mode & 0o777, 0o644);
  await assert.rejects(registerMcp(f.options), /private permissions/);
  await chmod(f.path, 0o600);
  await chmod(f.privateRoot, 0o755);
  assert.equal((await stat(f.privateRoot)).mode & 0o777, 0o755);
  await assert.rejects(registerMcp(f.options), /private permissions/);
  assert.equal(await readFile(f.path, "utf8"), "{}");
});

test("another setup process's lock is preserved", async (t) => {
  const f = await fixture(t);
  const lock = `${f.path}.szpont-integration.lock`;
  await writeFile(lock, "existing lock", { mode: 0o600 });
  await assert.rejects(registerMcp(f.options), /locked/);
  assert.equal(await readFile(lock, "utf8"), "existing lock");
});

test("JSONC and overlarge private files are preserved", async (t) => {
  const f = await fixture(t);
  f.config.claudeMcpConfig += "c";
  await assert.rejects(registerMcp(f.options), /JSONC/);
  f.config.claudeMcpConfig = f.path;
  const bytes = " ".repeat(65_537);
  await writeFile(f.path, bytes, { mode: 0o600 });
  await assert.rejects(registerMcp(f.options), /64 KiB/);
  assert.equal((await stat(f.path)).size, bytes.length);
});

for (const provider of ["claude", "opencode"])
  test(`${provider}: setup refuses a result exceeding the runner's file limit`, async (t) => {
    const f = await fixture(t, provider);
    const before = JSON.stringify({
      provider: { synthetic: { name: "x".repeat(65_450) } },
    });
    assert.ok(Buffer.byteLength(before) < 65_536);
    await writeFile(f.path, before, { mode: 0o600 });
    await assert.rejects(registerMcp(f.options), /64 KiB/);
    assert.equal(await readFile(f.path, "utf8"), before);
  });

test("Codex remote configuration never invokes automatic OAuth add and preserves all prior bytes", async (t) => {
  const f = await fixture(t, "codex");
  const fake = codexFake();
  const prior =
    '# Preserve this exact comment\nmodel = "synthetic"\n[features]\nweb_search = false\n';
  await writeFile(join(f.config.codexHome, "config.toml"), prior, {
    mode: 0o600,
  });
  const options = {
    ...f.options,
    execute: fake.execute,
    env: {
      PATH: "/usr/bin",
      HOME: f.privateRoot,
      DISCORD_BOT_TOKEN: secret,
      OPENAI_API_KEY: secret,
      GIT_DIR: secret,
    },
  };
  assert.equal((await registerMcp(options)).changed, true);
  assert.equal(fake.calls.length, 3);
  assert.equal(
    fake.calls.every(({ args }) => args[1] === "get"),
    true,
  );
  assert.equal(
    (
      await readFile(join(f.config.codexHome, "config.toml"), "utf8")
    ).startsWith(prior),
    true,
  );
  assert.equal((await registerMcp(options)).changed, false);
  assert.equal((await unregisterMcp(options)).status, "removed");
  for (const call of fake.calls) {
    assert.equal(
      call.options.env.CODEX_HOME.startsWith(f.config.codexHome),
      true,
    );
    assert.equal(call.binary, f.config.codexBin);
    assert.equal(call.options.timeout, 10_000);
    assert.equal(call.options.maxBuffer, 128 * 1024);
    assert.equal(JSON.stringify(call.options.env).includes(secret), false);
  }
  assert.equal(
    await readFile(join(f.config.codexHome, "config.toml"), "utf8"),
    prior,
  );
});

test("Codex local command arguments are passed without a shell", async (t) => {
  const f = await fixture(t, "codex");
  const fake = codexFake();
  const server = {
    command: "/path with spaces/python",
    args: ["-m", "szpont_browser", "literal-$(echo ignored)"],
    env: {
      DISPLAY: ":99",
      SZPONT_BROWSER_PROFILE: join(f.privateRoot, "browser profile"),
    },
  };
  await registerMcp({ ...f.options, server, execute: fake.execute });
  assert.deepEqual(fake.calls[1].args, [
    "mcp",
    "add",
    "szpont_docs",
    "--env",
    "DISPLAY=:99",
    "--env",
    `SZPONT_BROWSER_PROFILE=${server.env.SZPONT_BROWSER_PROFILE}`,
    "--",
    server.command,
    ...server.args,
  ]);
  assert.equal(fake.calls[1].options.shell, undefined);
});

test("Codex candidate validation failure preserves original bytes and cleans staging state", async (t) => {
  const f = await fixture(t, "codex");
  const path = join(f.config.codexHome, "config.toml");
  const prior = '# Existing exact bytes\nmodel = "fixture"\n';
  await writeFile(path, prior, { mode: 0o600 });
  let calls = 0;
  const execute = async (_binary, args) => {
    calls++;
    if (calls === 1)
      throw Object.assign(new Error(secret), {
        code: 1,
        stderr: `Error: No MCP server named '${args[2]}' found.\n`,
      });
    throw Object.assign(new Error(secret), { code: 1, stderr: secret });
  };
  await assert.rejects(
    registerMcp({ ...f.options, execute }),
    (error) => !error.message.includes(secret),
  );
  assert.equal(await readFile(path, "utf8"), prior);
  assert.deepEqual(await readdir(f.config.codexHome), ["config.toml"]);
});

test("Codex remote setup preserves an external edit detected before installation", async (t) => {
  const f = await fixture(t, "codex");
  const path = join(f.config.codexHome, "config.toml");
  await writeFile(path, "# Before\n", { mode: 0o600 });
  const fake = codexFake();
  const stagedEdit = async (...args) => {
    const reply = await fake.execute(...args);
    if (args[2].env.CODEX_HOME !== f.config.codexHome)
      await writeFile(path, "# External edit\n");
    return reply;
  };
  await assert.rejects(
    registerMcp({ ...f.options, execute: stagedEdit }),
    /changed during setup/,
  );
  assert.equal(await readFile(path, "utf8"), "# External edit\n");
  assert.deepEqual(await readdir(f.config.codexHome), ["config.toml"]);
});

test("Codex lock prevents another setup mutation and preserves that lock", async (t) => {
  const f = await fixture(t, "codex");
  const lock = join(f.config.codexHome, ".szpont-mcp.lock");
  await writeFile(lock, "existing lock", { mode: 0o600 });
  let calls = 0;
  await assert.rejects(
    registerMcp({
      ...f.options,
      execute: async () => {
        calls++;
      },
    }),
    /locked/,
  );
  assert.equal(calls, 0);
  assert.equal(await readFile(lock, "utf8"), "existing lock");
});

test("Codex never overwrites or removes a differing entry", async (t) => {
  const f = await fixture(t, "codex");
  const fake = codexFake();
  fake.set({
    name: "szpont_docs",
    enabled: true,
    transport: {
      type: "streamable_http",
      url: "https://other.example.test/mcp",
    },
  });
  const options = { ...f.options, execute: fake.execute };
  assert.equal((await inspectMcp(options)).status, "conflict");
  await assert.rejects(registerMcp(options), /preserved/);
  await assert.rejects(unregisterMcp(options), /preserved/);
  assert.equal(
    fake.calls.every(({ args }) => args[1] === "get"),
    true,
  );
});

for (const extra of [
  { disabled_tools: ["write"] },
  {
    transport: {
      type: "streamable_http",
      url: remote.url,
      http_headers: { Authorization: secret },
    },
  },
]) {
  test("Codex customized headers/tool restrictions prevent removal", async (t) => {
    const f = await fixture(t, "codex");
    const fake = codexFake();
    fake.set({
      name: "szpont_docs",
      enabled: true,
      transport: { type: "streamable_http", url: remote.url },
      ...extra,
    });
    await assert.rejects(
      unregisterMcp({ ...f.options, execute: fake.execute }),
      /preserved/,
    );
    assert.equal(fake.calls.length, 1);
  });
}

test("Codex errors and malformed output with secrets are redacted, never treated as missing", async (t) => {
  const f = await fixture(t, "codex");
  for (const execute of [
    async () => {
      throw Object.assign(new Error(secret), { code: 1, stderr: secret });
    },
    async () => ({ stdout: secret }),
  ]) {
    await assert.rejects(
      registerMcp({ ...f.options, execute }),
      (error) => !error.message.includes(secret),
    );
  }
});

test("Codex private home/config symlinks and insecure config are refused before subprocess execution", async (t) => {
  const f = await fixture(t, "codex");
  let calls = 0;
  const execute = async () => {
    calls++;
  };
  const configPath = join(f.config.codexHome, "config.toml");
  await writeFile(configPath, "synthetic = true", { mode: 0o644 });
  await chmod(configPath, 0o644);
  assert.equal((await stat(configPath)).mode & 0o777, 0o644);
  await assert.rejects(
    registerMcp({ ...f.options, execute }),
    /private permissions/,
  );
  await rm(configPath);
  await symlink(join(f.privateRoot, "not-found"), configPath);
  await assert.rejects(registerMcp({ ...f.options, execute }), /symlink/);
  assert.equal(calls, 0);
});

for (const server of [
  { url: "http://example.test/mcp" },
  { url: `https://user:${secret}@example.test/mcp` },
  { url: `https://example.test/mcp?token=${secret}` },
  { url: remote.url, headers: { Authorization: secret } },
  { command: "python", args: [], env: { OPENAI_API_KEY: secret } },
  { command: "python", args: [], env: { DISPLAY: "remote-host:0" } },
  {
    command: "python",
    args: [],
    env: { SZPONT_BROWSER_PROFILE: "relative/path" },
  },
  { command: "python", args: "shell string" },
]) {
  test("invalid or secret-bearing server definitions are refused before mutation", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      registerMcp({ ...f.options, server }),
      (error) => !error.message.includes(secret),
    );
    assert.deepEqual(await readdir(f.privateRoot), ["codex"]);
  });
}

test("unsafe provider/server names and browser paths inside public source are rejected", async (t) => {
  const f = await fixture(t);
  for (const name of ["--option", "__proto__", "constructor", "a/b", ""])
    await assert.rejects(registerMcp({ ...f.options, name }), /safe MCP/);
  await assert.rejects(
    registerMcp({ ...f.options, provider: "unknown" }),
    /supported MCP/,
  );
  await assert.rejects(
    registerMcp({
      ...f.options,
      server: {
        command: "python",
        args: [],
        env: { SZPONT_BROWSER_PROFILE: join(f.publicRoot, "browser") },
      },
    }),
    /public source/,
  );
});
