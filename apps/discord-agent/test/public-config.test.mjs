import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, authorized } from "../dist/config.js";
const env = {
  DISCORD_BOT_TOKEN: "synthetic-test-value",
  SZPONT_DISCORD_GUILD_ID: "111111111111111111",
  SZPONT_DISCORD_OWNER_ID: "222222222222222222",
  SZPONT_DISCORD_BOT_ID: "333333333333333333",
  SZPONT_DISCORD_PARENT_CHANNEL_ID: "444444444444444444",
  SZPONT_WORKSPACE: "/tmp/private/workspace",
  SZPONT_STATE_DIR: "/tmp/private/state",
  SZPONT_ARTIFACTS_DIR: "/tmp/private/artifacts",
  CODEX_HOME: "/tmp/private/codex",
};
test("configuration requires each deployment identity with no owner fallback", () => {
  const config = loadConfig(env);
  assert.equal(config.guildId, "111111111111111111");
  assert.equal(config.ownerId, "222222222222222222");
  assert.equal(config.botId, "333333333333333333");
  for (const key of [
    "SZPONT_DISCORD_GUILD_ID",
    "SZPONT_DISCORD_OWNER_ID",
    "SZPONT_DISCORD_BOT_ID",
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
