import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../dist/engine.js";
import { Store } from "../dist/store.js";
import { threadStatus } from "../dist/status.js";
const thread = "5555000000000000001";
const id = (n) => String(5555000000000001000n + BigInt(n));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "plompy-effects-engine-"));
  for (const name of [
    "workspace/agent/memory",
    "workspace/agent/conversations",
    "state",
  ])
    await mkdir(join(root, name), { recursive: true });
  for (const name of ["SOUL", "USER", "MEMORY", "POLICY"])
    await writeFile(
      join(root, `workspace/agent/${name}.md`),
      `# Synthetic ${name}`,
    );
  const config = {
    guildId: "111111111111111111",
    ownerId: "222222222222222222",
    botId: "333333333333333333",
    parentId: "444444444444444444",
    token: "synthetic-token",
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    codexHome: join(root, "codex"),
    browserDir: join(root, "browser"),
    codexBin: "fake",
    timeoutMs: 1000,
  };
  const path = join(root, "state/queue.sqlite");
  let store = new Store(path);
  const clock = { value: Date.now() + 100 };
  const exports = [],
    syncs = [],
    sent = [];
  let runs = 0;
  const deps = {
    ready: async () => false,
    run: async () => {
      runs++;
      throw new Error("maintenance must not execute model work");
    },
    persist: async (_c, _s, target) => {
      exports.push(target);
    },
    sync: async (_c, label) => {
      syncs.push(label);
      return "clean";
    },
    now: () => clock.value,
  };
  const transport = {
    send: async (_thread, text) => sent.push(text),
    typing: async () => {},
  };
  const make = () => new Engine(config, store, transport, deps);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    config,
    clock,
    exports,
    syncs,
    sent,
    deps,
    make,
    get store() {
      return store;
    },
    get runs() {
      return runs;
    },
    reopen() {
      store.close();
      store = new Store(path);
      store.recoverStartup();
    },
  };
}

test("transcript failure retries across restart and unavailable auth without executing Codex", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "synthetic request");
  f.deps.persist = async () => {
    throw new Error("sensitive /private/path diagnostic");
  };
  await f.make().kick();
  assert.equal(f.store.get(id(1)).status, "queued");
  assert.equal(f.store.effect(thread).last_error, "transcript_export_failed");
  assert.equal(f.syncs.length, 0);
  assert.match(
    threadStatus(f.store, thread, false),
    /transcript export is degraded/,
  );
  assert.doesNotMatch(
    threadStatus(f.store, thread, false),
    /private\/path|sensitive/,
  );
  const retry = f.store.effect(thread).retry_at;
  f.reopen();
  f.clock.value = retry + 1;
  f.deps.persist = async (_c, _s, target) => f.exports.push(target);
  await f.make().kick();
  assert.deepEqual(f.exports, [thread]);
  assert.deepEqual(f.syncs, [id(1)]);
  assert.equal(
    f.store.effect(thread).synced_generation,
    f.store.effect(thread).generation,
  );
  assert.equal(f.store.effect(thread).last_error, null);
  assert.equal(f.runs, 0);
});

test("blocked Git sync remains pending across restart without repeating an already successful transcript export", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "synthetic request");
  f.deps.sync = async (_c, label) => {
    f.syncs.push(label);
    return "blocked";
  };
  await f.make().kick();
  assert.equal(f.exports.length, 1);
  assert.equal(f.store.effect(thread).last_error, "memory_sync_blocked");
  assert.equal(
    f.store.effect(thread).exported_generation,
    f.store.effect(thread).generation,
  );
  assert.match(
    threadStatus(f.store, thread, false),
    /memory Git sync is blocked/,
  );
  const retry = f.store.effect(thread).retry_at;
  f.reopen();
  f.clock.value = retry + 1;
  f.deps.sync = async (_c, label) => {
    f.syncs.push(label);
    return "committed";
  };
  await f.make().kick();
  assert.equal(f.exports.length, 1);
  assert.equal(f.syncs.length, 2);
  assert.equal(
    f.store.effect(thread).synced_generation,
    f.store.effect(thread).generation,
  );
  assert.equal(f.runs, 0);
});

test("completion of a captured generation cannot acknowledge a newer enqueue during export", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "first synthetic request");
  let capture;
  f.deps.persist = async () => {
    capture = f.store.effect(thread).generation;
    f.store.enqueue(id(2), thread, "second synthetic request");
  };
  await f.make().kick();
  const pending = f.store.effect(thread);
  assert.ok(pending.generation > capture);
  assert.equal(pending.exported_generation, capture);
  assert.equal(pending.synced_generation, capture);
  f.deps.persist = async (_c, _s, target) => f.exports.push(target);
  await f.make().kick();
  assert.equal(f.store.effect(thread).synced_generation, pending.generation);
  assert.equal(f.runs, 0);
});

test("one maintenance pass handles at most two due threads and does not spin on failure", async (t) => {
  const f = await fixture(t);
  for (let n = 1; n <= 4; n++)
    f.store.enqueue(id(n), String(BigInt(thread) + BigInt(n)), "synthetic");
  f.deps.persist = async (_c, _s, target) => {
    f.exports.push(target);
    throw new Error("failed");
  };
  await f.make().kick();
  assert.equal(f.exports.length, 2);
  assert.equal(f.runs, 0);
  assert.equal(f.store.pendingEffects(f.clock.value, 20).length, 2);
});

test("a sync exception and unknown sync response stay degraded instead of being marked caught up", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "synthetic");
  for (const response of ["throw", "unrecognized"]) {
    f.deps.sync = async () => {
      if (response === "throw") throw new Error("secret diagnostic");
      return response;
    };
    await f.make().kick();
    const effect = f.store.effect(thread);
    assert.equal(effect.last_error, "memory_sync_failed");
    assert.ok(effect.synced_generation < effect.generation);
    f.clock.value = effect.retry_at + 1;
  }
  assert.equal(f.runs, 0);
});

test("stop during maintenance preserves a completed result and the pending export for next startup", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "synthetic");
  f.store.claim();
  f.store.finish(id(1), "succeeded", "Verified completed result");
  const engine = f.make();
  f.deps.persist = async () => {
    engine.stop();
    throw new Error("export unavailable");
  };
  await engine.kick();
  assert.equal(f.store.get(id(1)).status, "succeeded");
  assert.equal(f.store.get(id(1)).result, "Verified completed result");
  assert.equal(f.store.effect(thread).last_error, "transcript_export_failed");
  f.reopen();
  f.clock.value += 10_000;
  f.deps.persist = async (_c, _s, target) => f.exports.push(target);
  await f.make().kick();
  assert.equal(f.store.get(id(1)).status, "succeeded");
  assert.equal(f.runs, 0);
});
