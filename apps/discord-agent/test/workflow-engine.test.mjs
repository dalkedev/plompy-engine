import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { Engine } from "../dist/engine.js";
import { Store } from "../dist/store.js";
import { threadStatus } from "../dist/status.js";

const thread = "5555000000000000001",
  other = "5555000000000000002";
const id = (n) => String(5555000000000001000n + BigInt(n));
const sid = "01a12345-1234-7456-8456-123456789abc";
const sid2 = "01a12345-1234-7456-8456-123456789def";
const output = (
  outcome = "completed",
  summary = "Verified checkpoint",
  nextAction = "",
) => JSON.stringify({ outcome, summary, nextAction });
const success = (text = "Done", sessionId = sid) => ({
  ok: true,
  output: text,
  sessionId,
  error: null,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "szpont-work-engine-"));
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
    await writeFile(
      join(root, `workspace/agent/${name}.md`),
      `# Synthetic ${name}`,
    );
  const config = {
    guildId: "111111111111111111",
    ownerId: "222222222222222222",
    botId: "333333333333333333",
    parentId: "444444444444444444",
    token: "synthetic-discord-secret",
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    codexHome: join(root, "codex"),
    browserDir: join(root, "browser"),
    codexBin: "fake",
    timeoutMs: 600_000,
  };
  const store = new Store(join(root, "state/queue.sqlite"));
  const sent = [],
    calls = [];
  const clock = { value: Date.now() + 100 };
  const deps = {
    ready: async () => true,
    run: async (c, prompt, session, save, signal, options) => {
      calls.push({ c, prompt, session, signal, options });
      if (!session) save(sid);
      clock.value += 10;
      return success(options?.workflow ? output() : "Done");
    },
    persist: async () => {},
    sync: async () => "clean",
    now: () => clock.value,
    monotonicNow: () => clock.value,
  };
  const transport = {
    send: async (channel, text) => sent.push({ channel, text }),
    typing: async () => {},
  };
  const engines = [];
  const make = (dependencies = deps, channel = transport) => {
    const engine = new Engine(config, store, channel, dependencies);
    engines.push(engine);
    return engine;
  };
  t.after(async () => {
    for (const engine of engines) engine.stop();
    for (const engine of engines) await drain(engine);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const message = (n, content, channelId = thread) => ({
    id: id(n),
    guildId: config.guildId,
    authorId: config.ownerId,
    channelId,
    parentId: config.parentId,
    bot: false,
    webhook: false,
    thread: true,
    attachments: 0,
    content,
  });
  return {
    root,
    config,
    store,
    sent,
    calls,
    clock,
    deps,
    transport,
    make,
    message,
  };
}
async function withinDeadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function drain(engine) {
  // kick joins the current tick. Wait on its completion, not a count of event-loop
  // turns: filesystem work may stay pending through many immediate callbacks.
  await withinDeadline(
    engine.kick(),
    "fake engine did not settle within 10 seconds",
  );
  assert.equal(
    engine.isBusy(),
    false,
    "fake engine must settle without replay",
  );
}

test("committed intake runs even when transcript export and queued/start notices all fail", async (t) => {
  const f = await fixture(t);
  let exports = 0;
  f.deps.persist = async () => {
    exports++;
    throw new Error("sensitive export diagnostic");
  };
  f.transport.send = async () => {
    throw new Error("sensitive transport diagnostic");
  };
  const engine = f.make();
  assert.equal(
    await engine.accept(f.message(1, "Finish the synthetic task")),
    true,
  );
  await drain(engine);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get(id(1)).status, "succeeded");
  assert.equal(f.store.get(id(1)).notification, "ambiguous");
  assert.equal(f.store.effect(thread).last_error, "transcript_export_failed");
  assert.ok(exports >= 1);
  await engine.kick();
  assert.equal(f.calls.length, 1);
});

test("committed manual recovery reports queued despite export failure and runs once", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "original");
  f.store.claim();
  f.store.finish(id(1), "interrupted", "partial", "task_timeout");
  f.store.setSession(thread, sid);
  f.deps.persist = async () => {
    throw new Error("export refused");
  };
  const engine = f.make();
  await engine.accept(f.message(2, `!recover ${id(1)}`));
  await drain(engine);
  assert.equal(f.store.get(id(2)).status, "succeeded");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].session, sid);
  assert.ok(f.sent.some(({ text }) => /Manual recovery queued/.test(text)));
  assert.ok(!f.sent.some(({ text }) => /Cannot perform/.test(text)));
});

test("bounded steps yield to another thread, keep parent ID/exact session and exclude exports from budget", async (t) => {
  const f = await fixture(t);
  f.store.enqueueWorkflow(id(1), thread, "Build the synthetic fixture", 60_000);
  f.store.enqueue(id(2), other, "Other thread task");
  f.store.enqueue(id(3), thread, "Follow up only after workflow");
  f.deps.persist = async () => {
    f.clock.value += 300_000;
  };
  let workSteps = 0;
  f.deps.run = async (c, prompt, session, save, _signal, options) => {
    const workflow = options?.workflow;
    f.calls.push({ c, prompt, session, options });
    if (!session) save(prompt.includes(other) ? sid2 : sid);
    f.clock.value += 1000;
    if (workflow) {
      workSteps++;
      return success(
        output(
          workSteps === 1 ? "continue" : "completed",
          `step ${workSteps}`,
          workSteps === 1 ? "Verify the next fixture" : "",
        ),
      );
    }
    return success("Other ordinary result");
  };
  const engine = f.make();
  await engine.kick();
  assert.equal(f.calls.length, 4);
  assert.deepEqual(
    f.calls.map((c) => Boolean(c.options?.workflow)),
    [true, false, true, false],
  );
  assert.equal(f.calls[0].session, null);
  assert.equal(f.calls[2].session, sid);
  assert.equal(f.calls[3].session, sid);
  assert.match(f.calls[2].prompt, /step 1/);
  assert.equal(f.store.workflow(id(1)).elapsed_ms, 2000);
  assert.equal(f.store.workflow(id(1)).step_count, 2);
  assert.equal(f.store.workflow(id(1)).state, "completed");
  assert.equal(f.store.get(id(1)).result, "step 2");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs").get().n, 3);
});

test("verified budget pause releases thread and a fresh explicit budget resumes its saved session", async (t) => {
  const f = await fixture(t);
  let paused = true;
  f.deps.run = async (c, prompt, session, save, _signal, options) => {
    f.calls.push({ c, prompt, session, options });
    if (!session) save(sid);
    f.clock.value += paused ? 30_000 : 10;
    return success(
      output(
        paused ? "continue" : "completed",
        "Checkpoint",
        paused ? "Continue remaining work" : "",
      ),
    );
  };
  const engine = f.make();
  await engine.accept(f.message(1, "!work 1m Full goal with several words"));
  await drain(engine);
  assert.equal(f.store.workflow(id(1)).state, "paused");
  assert.equal(f.store.get(id(1)).error_code, "workflow_budget_exhausted");
  assert.deepEqual(
    f.calls.map((c) => c.c.timeoutMs),
    [60_000, 30_000],
  );
  assert.equal(
    f.store.db
      .prepare("SELECT blocked_reason FROM conversations WHERE thread_id=?")
      .get(thread).blocked_reason,
    null,
  );
  assert.ok(
    f.sent.some(({ text }) => /not marked complete.*not blocked/s.test(text)),
  );
  assert.throws(() => f.store.recover(id(1), thread, id(99)));
  paused = false;
  await engine.accept(f.message(2, "!work 1m Continue the fixed goal"));
  await drain(engine);
  assert.equal(f.calls.at(-1).session, sid);
  assert.equal(f.store.workflow(id(2)).state, "completed");
});

test("workflow step cap pauses after verified checkpoints without claiming overall completion", async (t) => {
  const f = await fixture(t);
  f.store.enqueueWorkflow(id(1), thread, "Capped synthetic goal", 60_000, 2);
  f.deps.run = async (_c, _p, session, save) => {
    if (!session) save(sid);
    f.clock.value++;
    return success(output("continue", "Verified", "next"));
  };
  const engine = f.make();
  await engine.kick();
  assert.equal(f.store.workflow(id(1)).step_count, 2);
  assert.equal(f.store.workflow(id(1)).state, "paused");
  assert.equal(f.store.get(id(1)).error_code, "workflow_step_limit");
  assert.match(
    threadStatus(f.store, thread, true),
    /goal is not marked complete/,
  );
});

for (const [name, result] of [
  ["malformed JSON", success("not a checkpoint")],
  [
    "extra properties",
    success(
      '{"outcome":"continue","summary":"x","nextAction":"y","injected":"unsafe"}',
    ),
  ],
  [
    "ambiguous timeout",
    {
      ok: false,
      output: output("continue", "partial", "next"),
      error: "task_timeout",
      sessionId: sid,
    },
  ],
  [
    "mismatched session",
    {
      ok: false,
      output: output(),
      error: "session_identity_mismatch",
      sessionId: sid,
    },
  ],
])
  test(`${name} stops the workflow and never automatically replays`, async (t) => {
    const f = await fixture(t);
    f.store.enqueueWorkflow(id(1), thread, "Original goal", 60_000);
    f.store.enqueue(id(2), thread, "must wait");
    let runs = 0;
    f.deps.run = async (_c, _p, session, save) => {
      runs++;
      if (!session) save(sid);
      f.clock.value++;
      return result;
    };
    const engine = f.make();
    await engine.kick();
    await engine.kick();
    assert.equal(runs, 1);
    assert.equal(f.store.workflow(id(1)).state, "blocked");
    assert.equal(f.store.get(id(2)).status, "queued");
    assert.notEqual(f.store.get(id(1)).status, "succeeded");
    assert.equal(f.store.workflow(id(1)).step_count, 0);
  });

test("blocked structured outcome is a verified checkpoint but requires manual recovery", async (t) => {
  const f = await fixture(t);
  f.store.enqueueWorkflow(id(1), thread, "Synthetic goal", 60_000);
  f.deps.run = async (_c, _p, session, save) => {
    if (!session) save(sid);
    f.clock.value += 40;
    return success(output("blocked", "Needs owner input"));
  };
  const engine = f.make();
  await engine.kick();
  assert.equal(f.store.workflow(id(1)).state, "blocked");
  assert.equal(f.store.workflow(id(1)).step_count, 1);
  assert.equal(f.store.get(id(1)).error_code, "workflow_blocked");
  assert.match(
    threadStatus(f.store, thread, true),
    new RegExp(`!recover ${id(1)}`),
  );
});

test("workflow checkpoint redacts exact transport token before durable storage and status", async (t) => {
  const f = await fixture(t);
  f.deps.run = async (_c, _p, session, save) => {
    if (!session) save(sid);
    return success(output("completed", `Saved ${f.config.token}`));
  };
  const engine = f.make();
  await engine.accept(f.message(1, `!work 1m Handle ${f.config.token}`));
  await drain(engine);
  const combined =
    JSON.stringify(f.store.workflow(id(1))) +
    f.store.get(id(1)).result +
    threadStatus(f.store, thread, true) +
    JSON.stringify(f.sent);
  assert.ok(!combined.includes(f.config.token));
  assert.match(combined, /redacted/);
});

test("only a leading explicit work command queues a budget; malformed command never queues", async (t) => {
  const f = await fixture(t);
  f.deps.ready = async () => false;
  const engine = f.make();
  await engine.accept(f.message(1, "!work two hours goal"));
  await engine.accept(f.message(2, "!work 30m"));
  await engine.accept(
    f.message(3, "Quoted instruction: !work 2h do something"),
  );
  await drain(engine);
  assert.equal(f.store.get(id(1)), undefined);
  assert.equal(f.store.get(id(2)), undefined);
  assert.equal(f.store.get(id(3)).status, "queued");
  assert.equal(f.store.workflow(id(3)), undefined);
});

test("workflow status contains only this thread's checkpoint and no foreign task, session or prompt", async (t) => {
  const f = await fixture(t);
  f.store.enqueueWorkflow(id(1), other, "foreign goal secret", 60_000);
  f.store.claim();
  f.store.setSession(other, sid2);
  f.store.checkpoint(
    id(1),
    {
      outcome: "continue",
      summary: "foreign checkpoint secret",
      nextAction: "foreign action",
    },
    1,
  );
  f.store.enqueueWorkflow(id(2), thread, "local goal private", 60_000);
  assert.equal(f.store.claim().id, id(1));
  f.store.checkpoint(
    id(1),
    { outcome: "completed", summary: "foreign result secret", nextAction: "" },
    1,
  );
  assert.equal(f.store.claim().id, id(2));
  f.store.setSession(thread, sid);
  f.store.checkpoint(
    id(2),
    {
      outcome: "continue",
      summary: "Local verified checkpoint",
      nextAction: "next",
    },
    1,
  );
  const text = threadStatus(f.store, thread, true);
  assert.match(text, /Local verified checkpoint/);
  for (const secret of [
    other,
    id(1),
    sid,
    sid2,
    "foreign",
    "local goal private",
  ])
    assert.ok(!text.includes(secret), secret);
});

test("an awaited concurrent tick joins in-flight execution instead of returning early or starting a second worker", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "Synthetic single worker task");
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.deps.run = async (_c, _p, session, save) => {
    f.calls.push({ session });
    entered();
    if (!session) save(sid);
    await wait;
    return success();
  };
  const engine = f.make();
  const first = engine.kick();
  await withinDeadline(started, "fake worker did not start within 10 seconds");
  let joined = false;
  const second = engine.kick().then(() => {
    joined = true;
  });
  await yieldTurn();
  assert.equal(joined, false);
  assert.equal(f.calls.length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(joined, true);
  assert.equal(f.store.get(id(1)).status, "succeeded");
});

test("an uncertain failure using the full budget stays blocked and status avoids an impossible recovery", async (t) => {
  const f = await fixture(t);
  f.store.enqueueWorkflow(id(1), thread, "Synthetic goal", 60_000);
  f.deps.run = async (_c, _p, session, save) => {
    if (!session) save(sid);
    f.clock.value += 60_000;
    return { ok: false, output: "", error: "task_timeout", sessionId: sid };
  };
  const engine = f.make();
  await engine.kick();
  const text = threadStatus(f.store, thread, true);
  assert.match(text, /Thread: blocked/);
  const next = text.split("\n").find((line) => line.startsWith("Next:"));
  assert.match(next, /!new-session/);
  assert.doesNotMatch(next, /!recover/);
  assert.throws(() => f.store.recover(id(1), thread, id(2)));
});

test("a committed workflow checkpoint survives failed progress and final notices without model replay", async (t) => {
  const f = await fixture(t);
  f.store.enqueueWorkflow(id(1), thread, "Synthetic goal", 60_000);
  let steps = 0;
  f.transport.send = async () => {
    throw new Error("delivery unavailable");
  };
  f.deps.run = async (_c, _p, session, save) => {
    if (!session) save(sid);
    steps++;
    f.clock.value++;
    return success(
      output(
        steps === 1 ? "continue" : "completed",
        `Verified step ${steps}`,
        steps === 1 ? "next" : "",
      ),
    );
  };
  const engine = f.make();
  await engine.kick();
  await engine.kick();
  assert.equal(steps, 2);
  assert.equal(f.store.workflow(id(1)).state, "completed");
  assert.equal(f.store.get(id(1)).result, "Verified step 2");
  assert.equal(f.store.get(id(1)).notification, "ambiguous");
});
