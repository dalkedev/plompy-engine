import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Engine } from "../dist/engine.js";
import { Store } from "../dist/store.js";

const thread = "5555000000000000001";
const jobId = "5555000000000001001";
const session = "01a12345-1234-7456-8456-123456789abc";
const checkpoint = (outcome = "blocked") => ({
  ok: true,
  output: JSON.stringify({
    outcome,
    summary: "Synthetic verified checkpoint",
    nextAction: outcome === "continue" ? "Continue the fixture" : "",
  }),
  sessionId: session,
  error: null,
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "szpont-execution-clock-"));
  for (const name of [
    "workspace/agent/memory",
    "workspace/agent/conversations",
    "state",
    "artifacts",
    "codex",
    "browser",
  ])
    await mkdir(join(root, name), { recursive: true });
  for (const name of ["SOUL", "USER", "MEMORY", "POLICY"])
    await writeFile(join(root, `workspace/agent/${name}.md`), "# Synthetic");
  const config = {
    guildId: "111111111111111111",
    ownerId: "222222222222222222",
    botId: "333333333333333333",
    parentId: "444444444444444444",
    token: "synthetic-test-secret",
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    codexHome: join(root, "codex"),
    browserDir: join(root, "browser"),
    publishSocket: join(root, "publisher.sock"),
    codexBin: "unused",
    timeoutMs: 120_000,
    weeklyEnabled: false,
  };
  const store = new Store(join(root, "state/queue.sqlite"));
  const clock = { wall: Date.now() + 1000, monotonic: 500 };
  const deps = {
    ready: async () => true,
    persist: async () => {},
    sync: async () => "clean",
    now: () => clock.wall,
    monotonicNow: () => clock.monotonic,
    run: async () => checkpoint(),
  };
  let engine;
  t.after(async () => {
    engine?.stop();
    if (engine) await engine.kick();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const make = () =>
    (engine = new Engine(
      config,
      store,
      { send: async () => {}, typing: async () => {} },
      deps,
    ));
  return { config, store, clock, deps, make };
}

for (const wallJump of [-600_000, 600_000])
  test(`execution budget ignores a ${wallJump}ms wall-clock correction`, async (t) => {
    const f = await fixture(t);
    f.store.enqueueWorkflow(jobId, thread, "Synthetic fixed goal", 60_000);
    f.deps.run = async (_config, _prompt, _session, save) => {
      save(session);
      f.clock.monotonic += 1234.2;
      f.clock.wall += wallJump;
      return checkpoint();
    };
    await f.make().kick();
    assert.equal(f.store.workflow(jobId).elapsed_ms, 1235);
    assert.equal(f.store.workflow(jobId).step_count, 1);
    assert.equal(f.store.get(jobId).error_code, "workflow_blocked");
  });

test("workflow timeout uses monotonic remaining budget and excludes maintenance waits", async (t) => {
  const f = await fixture(t);
  const timeouts = [];
  f.store.enqueueWorkflow(jobId, thread, "Synthetic fixed goal", 60_000);
  f.deps.persist = async () => {
    f.clock.monotonic += 300_000;
    f.clock.wall += 300_000;
  };
  f.deps.run = async (config, _prompt, _session, save) => {
    save(session);
    timeouts.push(config.timeoutMs);
    f.clock.monotonic += timeouts.length === 1 ? 40_000 : 20_000;
    f.clock.wall += timeouts.length === 1 ? -600_000 : 1_200_000;
    return checkpoint("continue");
  };
  await f.make().kick();
  assert.deepEqual(timeouts, [60_000, 20_000]);
  assert.equal(f.store.workflow(jobId).elapsed_ms, 60_000);
  assert.equal(f.store.workflow(jobId).state, "paused");
  assert.equal(f.store.get(jobId).error_code, "workflow_budget_exhausted");
});

for (const failure of [
  "exception",
  "task_timeout",
  "owner_or_service_cancelled",
])
  test(`${failure} charges monotonic execution once and does not replay`, async (t) => {
    const f = await fixture(t);
    let runs = 0;
    f.store.enqueueWorkflow(jobId, thread, "Synthetic fixed goal", 60_000);
    f.deps.run = async (_config, _prompt, _session, save) => {
      runs++;
      save(session);
      f.clock.monotonic += 3750;
      f.clock.wall -= 600_000;
      if (failure === "exception") throw new Error("Synthetic run failure");
      return { ok: false, output: "", sessionId: session, error: failure };
    };
    const engine = f.make();
    await engine.kick();
    await engine.kick();
    assert.equal(runs, 1);
    assert.equal(f.store.workflow(jobId).elapsed_ms, 3750);
    assert.equal(f.store.workflow(jobId).state, "blocked");
    assert.equal(f.store.get(jobId).status, "interrupted");
    assert.equal(
      f.store.get(jobId).error_code,
      failure === "exception" ? "engine_turn_interrupted" : failure,
    );
  });

test("ordinary turns keep their configured timeout under a wall-clock correction", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(jobId, thread, "Synthetic ordinary task");
  let runs = 0;
  f.deps.run = async (config, _prompt, _session, save) => {
    runs++;
    assert.equal(config.timeoutMs, f.config.timeoutMs);
    save(session);
    f.clock.monotonic += 200;
    f.clock.wall -= 600_000;
    return {
      ok: true,
      output: "Synthetic result",
      sessionId: session,
      error: null,
    };
  };
  const engine = f.make();
  await engine.kick();
  await engine.kick();
  assert.equal(runs, 1);
  assert.equal(f.store.get(jobId).status, "succeeded");
  assert.equal(f.store.get(jobId).result, "Synthetic result");
  assert.equal(f.store.workflow(jobId), undefined);
});

test("default execution clock remains monotonic when Date.now moves backwards", async (t) => {
  const f = await fixture(t);
  delete f.deps.monotonicNow;
  const original = Date.now;
  let offset = 0;
  Date.now = () => original() + offset;
  try {
    f.store.enqueueWorkflow(jobId, thread, "Synthetic fixed goal", 60_000);
    f.deps.run = async (_config, _prompt, _session, save) => {
      save(session);
      await delay(35);
      offset = -60_000;
      f.clock.wall -= 60_000;
      return checkpoint();
    };
    await f.make().kick();
    const spent = f.store.workflow(jobId).elapsed_ms;
    assert.ok(spent >= 20, `Actual execution was charged ${spent}ms`);
    assert.ok(spent < 10_000, "No wall-clock correction should be charged");
  } finally {
    Date.now = original;
  }
});
