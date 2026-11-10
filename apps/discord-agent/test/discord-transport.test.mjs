import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { DiscordTransport } from "../dist/discord.js";

const config = {
  token: "synthetic-discord-transport-token",
  guildId: "111111111111111111",
  ownerId: "222222222222222222",
  botId: "333333333333333333",
  parentId: "444444444444444444",
};
const otherOwner = "555555555555555555";

function fixture(
  t,
  {
    cachedOwner,
    actualOwner = config.ownerId,
    restError,
    cachedPermissions = PermissionFlagsBits.ViewChannel,
  } = {},
) {
  const transport = new DiscordTransport(config);
  t.after(() => transport.client.destroy());
  transport.client.user = { id: config.botId };
  transport.client.options.shardCount = 1;
  // This is the SDK's real unavailable Guild, as populated before GUILD_CREATE.
  const cached = transport.client.guilds._add({
    id: config.guildId,
    unavailable: true,
    shardId: 0,
  });
  if (cachedOwner !== undefined) cached.ownerId = cachedOwner;
  const oldEveryone = cached.roles._add({
    id: config.guildId,
    name: "@everyone",
    permissions: String(cachedPermissions),
  });
  const reads = [],
    inspectedRoles = [];
  transport.client.rest.get = async (route) => {
    reads.push(route);
    assert.equal(route, `/guilds/${config.guildId}`);
    if (restError) throw restError;
    return {
      id: config.guildId,
      owner_id: actualOwner,
      unavailable: false,
      roles: [{ id: config.guildId, name: "@everyone", permissions: "0" }],
    };
  };
  transport.client.channels.fetch = async (id, options) => {
    assert.equal(id, config.parentId);
    assert.equal(options.force, true);
    return {
      type: 15,
      guildId: config.guildId,
      permissionsFor(role) {
        inspectedRoles.push(role);
        return role.permissions;
      },
      permissionOverwrites: { cache: new Map() },
    };
  };
  return { transport, cached, oldEveryone, reads, inspectedRoles };
}

for (const cachedOwner of [undefined, otherOwner]) {
  test(`validation refreshes an unavailable guild with ${cachedOwner === undefined ? "missing" : "stale"} ownership before authorization`, async (t) => {
    const f = fixture(t, { cachedOwner });
    assert.equal(f.cached.available, false);
    await f.transport.validate();
    assert.deepEqual(f.reads, [`/guilds/${config.guildId}`]);
    assert.equal(f.cached.ownerId, config.ownerId);
    assert.equal(f.cached.available, true);
    assert.equal(f.inspectedRoles.length, 1);
    assert.notEqual(f.inspectedRoles[0], f.oldEveryone);
    assert.equal(f.inspectedRoles[0].permissions.bitfield, 0n);
  });
}

test("a cached matching owner cannot bypass a different actual owner", async (t) => {
  const f = fixture(t, {
    cachedOwner: config.ownerId,
    actualOwner: otherOwner,
    cachedPermissions: 0n,
  });
  await assert.rejects(f.transport.validate(), /Guild owner mismatch/);
  assert.deepEqual(f.reads, [`/guilds/${config.guildId}`]);
  assert.equal(f.inspectedRoles.length, 0);
});

test("failed guild refresh never falls back to a matching cached owner", async (t) => {
  const restError = new Error("synthetic unavailable guild read");
  const f = fixture(t, {
    cachedOwner: config.ownerId,
    restError,
    cachedPermissions: 0n,
  });
  await assert.rejects(f.transport.validate(), (error) => error === restError);
  assert.equal(f.reads.length, 1);
  assert.equal(f.inspectedRoles.length, 0);
});

test("wrong bot identity is still rejected before any guild read", async (t) => {
  const f = fixture(t);
  f.transport.client.user = { id: otherOwner };
  await assert.rejects(f.transport.validate(), /Wrong bot identity/);
  assert.equal(f.reads.length, 0);
});
