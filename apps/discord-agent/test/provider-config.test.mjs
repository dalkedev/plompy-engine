import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, childEnvironment, isSessionId } from "../dist/config.js";
const env = {
  DISCORD_BOT_TOKEN: "synthetic-discord-secret",
  SZPONT_DISCORD_GUILD_ID: "111111111111111111",
  SZPONT_DISCORD_OWNER_ID: "222222222222222222",
  SZPONT_DISCORD_BOT_ID: "333333333333333333",
  SZPONT_DISCORD_PARENT_CHANNEL_ID: "444444444444444444",
  SZPONT_WORKSPACE: "/tmp/private/workspace",
  SZPONT_STATE_DIR: "/tmp/private/state",
  SZPONT_ARTIFACTS_DIR: "/tmp/private/artifacts",
  CODEX_HOME: "/tmp/private/codex",
};
test("Codex remains the default and alternate runners require only their selected private home", () => {
  assert.equal(loadConfig(env).provider, "codex");
  const other = { ...env };
  delete other.CODEX_HOME;
  assert.throws(() => loadConfig(other), /CODEX_HOME/);
  const claude = loadConfig({
    ...other,
    SZPONT_RUNNER: "claude",
    CLAUDE_CONFIG_DIR: "/tmp/private/claude",
  });
  assert.equal(claude.provider, "claude");
  const opencode = loadConfig({
    ...other,
    SZPONT_RUNNER: "opencode",
    SZPONT_OPENCODE_HOME: "/tmp/private/opencode",
    SZPONT_OPENCODE_MODEL: "example/model",
    SZPONT_OPENCODE_HOST_EXECUTION: "allow",
  });
  assert.equal(opencode.opencodeAllowHostExecution, true);
  assert.equal(opencode.opencodeModel, "example/model");
});
test("invalid runner, relative auth paths, model settings and accidental execution opt-ins fail closed", () => {
  for (const patch of [
    { SZPONT_RUNNER: "unknown" },
    { SZPONT_RUNNER: "claude" },
    { SZPONT_RUNNER: "claude", CLAUDE_CONFIG_DIR: "relative" },
    { SZPONT_CLAUDE_EFFORT: "ultra" },
    { SZPONT_CLAUDE_MODEL: "--dangerously-skip-permissions" },
    { SZPONT_CLAUDE_MCP_CONFIG: "relative.json" },
    { SZPONT_OPENCODE_HOST_EXECUTION: "true" },
    {
      SZPONT_RUNNER: "opencode",
      SZPONT_OPENCODE_HOME: "/tmp/private/opencode",
    },
    { SZPONT_OPENCODE_MODEL: "implicit-model" },
    { SZPONT_CODEX_BIN: "codex\n--bad" },
  ])
    assert.throws(() => loadConfig({ ...env, ...patch }));
});
test("runner child environments isolate provider configuration and never forward billing credentials or discovery overrides", () => {
  const config = loadConfig(env);
  const source = {
    PATH: "/usr/bin",
    HOME: "/private/service",
    LANG: "en_US.UTF-8",
    CODEX_HOME: "/wrong",
    CLAUDE_CONFIG_DIR: "/wrong",
    ANTHROPIC_API_KEY: "synthetic-key",
    OPENAI_API_KEY: "synthetic-key",
    GOOGLE_API_KEY: "synthetic-key",
    GH_TOKEN: "synthetic-key",
    GITHUB_TOKEN: "synthetic-key",
    GH_ENTERPRISE_TOKEN: "synthetic-key",
    GITHUB_ENTERPRISE_TOKEN: "synthetic-key",
    GH_CONFIG_DIR: "/personal/github",
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    OPENCODE_CONFIG: "/wrong/config",
    OPENCODE_PERMISSION: "allow",
    OPENCODE_CONFIG_CONTENT: "{}",
    UNRELATED_SECRET: "synthetic-key",
  };
  for (const provider of ["codex", "claude", "opencode"]) {
    const child = childEnvironment(
      {
        ...config,
        provider,
        claudeHome: "/private/claude",
        opencodeHome: "/private/opencode",
      },
      source,
    );
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "DISCORD_BOT_TOKEN",
      "UNRELATED_SECRET",
      "OPENCODE_CONFIG",
      "OPENCODE_PERMISSION",
      "OPENCODE_CONFIG_CONTENT",
    ])
      assert.equal(child[key], undefined, key);
    assert.equal(child.PATH, source.PATH);
    assert.equal(child.GH_CONFIG_DIR, "/tmp/private/github");
    assert.equal(
      child.CODEX_HOME,
      provider === "codex" ? config.codexHome : undefined,
    );
    assert.equal(
      child.CLAUDE_CONFIG_DIR,
      provider === "claude" ? "/private/claude" : undefined,
    );
    if (provider === "opencode") {
      assert.equal(child.HOME, "/private/opencode");
      assert.equal(child.XDG_DATA_HOME, "/private/opencode/data");
      assert.equal(child.XDG_CONFIG_HOME, "/private/opencode/config");
      assert.equal(child.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
      assert.equal(child.OPENCODE_PURE, "true");
      assert.equal(child.OPENCODE_DISABLE_DEFAULT_PLUGINS, undefined);
    }
  }
});
test("GitHub uses a dedicated private auth directory and validates explicit overrides", () => {
  const defaultConfig = loadConfig(env);
  assert.equal(defaultConfig.githubConfigDir, "/tmp/private/github");
  for (const value of [
    "relative/github",
    "",
    "/",
    "/tmp/private/workspace",
    "/tmp/private/workspace/github",
    "/tmp/private/github\nsecret",
  ])
    assert.throws(
      () => loadConfig({ ...env, GH_CONFIG_DIR: value }),
      /GH_CONFIG_DIR/,
    );

  const dedicated = "/tmp/github-integration";
  const config = loadConfig({ ...env, GH_CONFIG_DIR: dedicated });
  assert.equal(config.githubConfigDir, dedicated);
  for (const provider of ["codex", "claude", "opencode"]) {
    const child = childEnvironment(
      { ...config, provider },
      {
        GH_CONFIG_DIR: "/personal/github",
        GH_TOKEN: "synthetic-unrelated-token",
        GITHUB_TOKEN: "synthetic-unrelated-token",
      },
    );
    assert.equal(child.GH_CONFIG_DIR, dedicated);
    assert.equal(child.GH_TOKEN, undefined);
    assert.equal(child.GITHUB_TOKEN, undefined);
  }
  const withoutOptional = { ...config };
  delete withoutOptional.githubConfigDir;
  assert.equal(
    childEnvironment(withoutOptional, {}).GH_CONFIG_DIR,
    "/tmp/private/github",
  );
});
test("GitHub credentials cannot overlap engine state or any provider home", () => {
  for (const provider of ["codex", "claude", "opencode"]) {
    const selected = {
      ...env,
      SZPONT_RUNNER: provider,
      CLAUDE_CONFIG_DIR: "/tmp/private/claude",
      SZPONT_OPENCODE_HOME: "/tmp/private/opencode",
      SZPONT_OPENCODE_MODEL: "example/model",
    };
    for (const directory of [
      selected.SZPONT_WORKSPACE,
      selected.SZPONT_STATE_DIR,
      selected.CODEX_HOME,
      selected.CLAUDE_CONFIG_DIR,
      selected.SZPONT_OPENCODE_HOME,
    ])
      for (const github of [directory, `${directory}/github`, "/tmp/private"])
        assert.throws(
          () => loadConfig({ ...selected, GH_CONFIG_DIR: github }),
          /GH_CONFIG_DIR/,
          `${provider}: ${github}`,
        );
    assert.equal(loadConfig(selected).githubConfigDir, "/tmp/private/github");
  }
});
test("session identifiers are validated for the recorded provider", () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  assert.equal(isSessionId(uuid, "codex"), true);
  assert.equal(isSessionId(uuid, "claude"), true);
  assert.equal(isSessionId(uuid, "opencode"), false);
  assert.equal(isSessionId("ses_0123456789abcdefghijklmnop", "opencode"), true);
  for (const value of [
    "ses_a",
    "ses_" + "a".repeat(121),
    "ses_12345678/../../",
    "ses_12345678\n",
  ])
    assert.equal(isSessionId(value, "opencode"), false);
});
