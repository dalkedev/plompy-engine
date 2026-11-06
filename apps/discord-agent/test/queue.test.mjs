import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../dist/engine.js";
import { Store } from "../dist/store.js";
import { threadQueue } from "../dist/queue.js";

const thread = "5555000000000000001";
const otherThread = "5555000000000000002";
const thirdThread = "5555000000000000003";
const id = (n) => String(5555000000000001000n + BigInt(n));
const session = "01a12345-1234-7456-8456-123456789abc";
const config = {
  guildId: "111111111111111111",
  ownerId: "222222222222222222",
  botId: "333333333333333333",
  token: "fixture-discord-token",
  parentId: "444444444444444444",
  workspace: "/synthetic/workspace",
  stateDir: "/synthetic/state",
  artifactsDir: "/synthetic/artifacts",
  codexHome: "/synthetic/codex",
  browserDir: "/synthetic/browser",
  codexBin: "codex",
  timeoutMs: 1000,
};

function fixture(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return store;
}

function snapshot(store) {
  return Object.fromEntries(
    [
      "jobs",
      "conversations",
      "workflows",
      "workflow_steps",
      "job_acceptance",
      "effects",
    ].map((table) => [table, store.db.prepare(`SELECT * FROM ${table}`).all()]),
  );
}

function message(number, content, overrides = {}) {
  return {
    id: id(number),
    guildId: config.guildId,
    authorId: config.ownerId,
    channelId: thread,
    parentId: config.parentId,
    bot: false,
    webhook: false,
    thread: true,
    attachments: 0,
    content,
    ...overrides,
  };
}

function nextLine(text) {
  return text.split("\n").find((line) => line.startsWith("Next:"));
}

function controls(t, store, overrides = {}) {
  const sent = [];
  const calls = [];
  const forbidden = (name) => async () => {
    calls.push(name);
    throw new Error(`Queue inspection must not call ${name}`);
  };
  const engine = new Engine(
    { ...config, ...overrides },
    store,
    {
      send: async (threadId, text) => sent.push({ threadId, text }),
      typing: forbidden("typing"),
    },
    {
      ready: forbidden("ready"),
      run: forbidden("run"),
      persist: forbidden("persist"),
      sync: forbidden("sync"),
      fetchImage: forbidden("fetchImage"),
    },
  );
  t.after(() => engine.stop());
  return { engine, sent, calls };
}

test("queue inspection of a new thread is read-only and does not create a runner binding", (t) => {
  const store = fixture(t);
  const before = snapshot(store);
  assert.deepEqual(store.queue(thread), { workerBusy: false, items: [] });
  const text = threadQueue(store, thread, false);
  assert.match(text, /No queued or running tasks in this thread/);
  assert.match(text, /Worker: idle/);
  assert.match(nextLine(text), /send a normal message or !work/);
  assert.equal(store.provider(thread), null);
  assert.deepEqual(snapshot(store), before);
});

test("queue eligibility and claim agree on the first accepted task, independent of wall clock and message IDs", (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);
  const store = fixture(t);
  store.enqueue(id(9), thread, "first accepted prompt");
  now = 1000;
  store.enqueue(id(1), thread, "second accepted prompt");
  const before = snapshot(store);
  assert.deepEqual(store.queue(thread), {
    workerBusy: false,
    items: [
      { id: id(9), provider: "codex", status: "queued", reason: "eligible" },
      {
        id: id(1),
        provider: "codex",
        status: "queued",
        reason: "earlier_task",
      },
    ],
  });
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.claim().id, id(9));
  assert.equal(store.claim(), undefined);
  assert.deepEqual(
    store.queue(thread).items.map((item) => item.reason),
    ["running", "eligible"],
  );
  store.finish(id(9), "succeeded", "first completed");
  assert.equal(store.claim().id, id(1));
});

test("yielding work keeps accepted order within its thread while another thread gets the shared worker", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(9), thread, "long private goal", 120_000);
  assert.equal(store.claim().id, id(9));
  store.enqueue(id(1), thread, "follow-up accepted during work");
  store.enqueue(id(2), otherThread, "independent work");
  store.checkpoint(
    id(9),
    {
      outcome: "continue",
      summary: "Private checkpoint",
      nextAction: "Continue",
    },
    1000,
  );
  assert.ok(store.get(id(9)).queued_at > store.get(id(1)).queued_at);
  assert.deepEqual(
    store.queue(thread).items.map((item) => [item.id, item.reason]),
    [
      [id(9), "eligible"],
      [id(1), "earlier_task"],
    ],
  );
  assert.equal(store.claim().id, id(2));
  assert.equal(store.queue(thread).workerBusy, true);
  assert.equal(store.claim(), undefined);
  store.finish(id(2), "succeeded", "independent work completed");
  assert.equal(store.claim().id, id(9));
  store.checkpoint(
    id(9),
    { outcome: "completed", summary: "Done", nextAction: "" },
    1000,
  );
  assert.equal(store.claim().id, id(1));
});

test("unavailable runners are distinguished from earlier tasks and become claimable only when ready", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "claude first", null, "claude");
  store.enqueue(id(2), thread, "claude follow-up");
  store.enqueue(id(3), otherThread, "opencode first", null, "opencode");
  assert.deepEqual(
    store.queue(thread, ["codex"]).items.map((item) => item.reason),
    ["runner_unavailable", "earlier_task"],
  );
  assert.equal(store.claim(["codex"]), undefined);
  assert.equal(store.claim(["opencode"]).id, id(3));
  store.finish(id(3), "succeeded", "done");
  assert.equal(store.queue(thread, ["claude"]).items[0].reason, "eligible");
  assert.equal(store.claim(["claude"]).id, id(1));
});

test("a runner snapshot mismatch is visible and cannot be overtaken by a later task", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "existing conversation");
  store.claim();
  store.finish(id(1), "succeeded", "done");
  // A legacy/imported inconsistent snapshot must fail closed even though ordinary
  // intake and immutable-provider triggers prevent creating it through the API.
  store.db
    .prepare(
      "INSERT INTO jobs(id,thread_id,prompt,status,created_at,queued_at,provider) VALUES(?,?,?,'queued',1,1,'claude')",
    )
    .run(id(2), thread, "private legacy prompt");
  store.enqueue(id(3), thread, "normal later prompt");
  assert.deepEqual(
    store.queue(thread).items.map((item) => item.reason),
    ["runner_mismatch", "earlier_task"],
  );
  assert.equal(store.claim(), undefined);
  assert.match(
    nextLine(threadQueue(store, thread, true)),
    /inspect runner bindings on the host/,
  );
});

test("blocked threads take precedence over login readiness and point at the latest accepted blocker", (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);
  const store = fixture(t);
  store.enqueue(id(9), thread, "private original instruction");
  store.claim();
  store.finish(id(9), "failed", "private original result", "turn_failed");
  now = 1000;
  store.recover(id(9), thread, id(1));
  store.claim();
  store.finish(id(1), "interrupted", "private recovery result", "task_timeout");
  store.enqueue(id(2), thread, "waiting follow-up");
  store.enqueue(id(3), thread, "another waiting follow-up");
  const before = snapshot(store);
  assert.deepEqual(
    store.queue(thread, []).items.map((item) => item.reason),
    ["blocked_thread", "blocked_thread"],
  );
  const text = threadQueue(store, thread, false);
  assert.match(nextLine(text), new RegExp(`!recover ${id(1)}`));
  assert.match(nextLine(text), new RegExp(`!result ${id(1)}`));
  assert.equal(store.recent(thread)[0].id, id(3));
  assert.doesNotMatch(nextLine(text), new RegExp(id(9)));
  assert.equal(store.claim(), undefined);
  assert.deepEqual(snapshot(store), before);
});

test("an exhausted workflow recommends a fresh explicit budget instead of a recover loop", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "private goal", 60_000);
  store.claim();
  store.finish(
    id(1),
    "interrupted",
    "private partial result",
    "task_timeout",
    60_000,
  );
  store.enqueue(id(2), thread, "private waiting follow-up");
  const text = threadQueue(store, thread, true);
  assert.match(nextLine(text), /!work 30m <goal>/);
  assert.match(nextLine(text), new RegExp(`!result ${id(1)}`));
  assert.equal(store.recent(thread)[0].id, id(2));
  assert.match(nextLine(text), /reconcile prior actions/);
  assert.doesNotMatch(nextLine(text), /!recover /);
  assert.equal(store.workflow(id(1)).elapsed_ms, 60_000);
});

test("worker occupancy is accurate in current, other and empty threads without exposing other identities", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), otherThread, "foreign private prompt");
  store.claim();
  store.enqueue(id(2), thread, "local waiting prompt");
  assert.match(
    threadQueue(store, otherThread, true),
    /Worker: running a task in this thread/,
  );
  assert.match(
    nextLine(threadQueue(store, otherThread, true)),
    /wait for the current task/,
  );
  for (const inspected of [thread, thirdThread]) {
    const text = threadQueue(store, inspected, true);
    assert.equal(store.queue(inspected).workerBusy, true);
    assert.match(text, /Worker: busy in another thread/);
    assert.doesNotMatch(
      text,
      new RegExp(`${otherThread}|${id(1)}|foreign private`),
    );
  }
});

test("queue output excludes completed history, prompts, results, checkpoints, raw block text and session IDs", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), otherThread, "FOREIGN_PROMPT_SENTINEL");
  store.claim();
  store.finish(id(1), "succeeded", "FOREIGN_RESULT_SENTINEL");
  store.setSession(otherThread, "01a12345-1234-7456-8456-123456789def");
  store.enqueueWorkflow(id(2), thread, "LOCAL_PROMPT_SENTINEL", 120_000);
  store.claim();
  store.checkpoint(
    id(2),
    {
      outcome: "continue",
      summary: "CHECKPOINT_SENTINEL",
      nextAction: "NEXT_ACTION_SENTINEL",
    },
    1000,
  );
  store.setSession(thread, session);
  store.db
    .prepare("UPDATE conversations SET blocked_reason=? WHERE thread_id=?")
    .run("/private/path/BLOCK_SENTINEL", thread);
  const before = snapshot(store);
  const text = threadQueue(store, thread, true);
  for (const forbidden of [
    "FOREIGN_PROMPT_SENTINEL",
    "FOREIGN_RESULT_SENTINEL",
    "LOCAL_PROMPT_SENTINEL",
    "CHECKPOINT_SENTINEL",
    "NEXT_ACTION_SENTINEL",
    "BLOCK_SENTINEL",
    "/private/path",
    otherThread,
    id(1),
    session,
    "789def",
  ])
    assert.ok(!text.includes(forbidden), forbidden);
  assert.match(text, new RegExp(`${id(2)}: queued`));
  assert.match(nextLine(text), /!status/);
  assert.deepEqual(snapshot(store), before);
});

test("a full thread returns eight active tasks with bounded content and no global rank or ETA", (t) => {
  const store = fixture(t);
  for (let number = 1; number <= 8; number++) {
    store.enqueue(id(number), thread, "private prompt ".repeat(100));
  }
  assert.throws(
    () => store.enqueue(id(9), thread, "beyond intake cap"),
    /Queue is full/,
  );
  const items = store.queue(thread).items;
  assert.equal(items.length, 8);
  assert.deepEqual(
    items.map((item) => item.id),
    Array.from({ length: 8 }, (_, n) => id(n + 1)),
  );
  const text = threadQueue(store, thread, true);
  assert.ok(text.length < 3000);
  assert.match(text, /not an ETA or a global queue rank/);
  assert.doesNotMatch(text, /private prompt/);
});

test("invalid provider filters fail without mutating queue state", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "preserve this task");
  const before = snapshot(store);
  for (const method of ["queue", "claim"]) {
    assert.throws(
      () =>
        method === "queue"
          ? store.queue(thread, ["not-a-runner"])
          : store.claim(["not-a-runner"]),
      /Invalid runner provider/,
    );
  }
  assert.equal(store.claim([]), undefined);
  assert.equal(store.queue(thread, []).items[0].reason, "runner_unavailable");
  assert.deepEqual(snapshot(store), before);
});

test("owner !queue is idempotent and read-only without runner probes, execution, memory export or session creation", async (t) => {
  const store = fixture(t);
  const { engine, sent, calls } = controls(t, store);
  const before = snapshot(store);
  await engine.accept(message(1, "!queue"));
  await engine.accept(message(1, "!queue"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, thread);
  assert.match(sent[0].text, /No queued or running tasks/);
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM controls").get().n, 1);
});

test("unauthorized !queue messages are ignored before control deduplication or disclosure", async (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "private queued task");
  const before = snapshot(store);
  const { engine, sent, calls } = controls(t, store);
  const forbidden = [
    { authorId: "999999999999999999" },
    { guildId: "999999999999999999" },
    { parentId: "999999999999999999" },
    { bot: true },
    { webhook: true },
    { thread: false },
  ];
  for (const [number, patch] of forbidden.entries()) {
    assert.equal(
      await engine.accept(message(20 + number, "!queue", patch)),
      false,
    );
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM controls").get().n, 0);
});

test("!queue rejects extra arguments or attachments without changing work or disclosing it", async (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "PRIVATE_PROMPT_SENTINEL");
  store.setSession(thread, session);
  const before = snapshot(store);
  const { engine, sent, calls } = controls(t, store);
  for (const [number, content] of [
    "!queue extra",
    `!queue ${id(1)}`,
    "!queue one two",
  ].entries()) {
    await engine.accept(message(20 + number, content));
    await engine.accept(message(20 + number, content));
    assert.match(sent[number].text, /^Usage: !queue\./);
    assert.match(sent[number].text, /nothing was queued/);
  }
  await engine.accept(
    message(30, "!queue", {
      attachments: 1,
      images: [
        {
          id: id(100),
          url: "https://cdn.discordapp.com/attachments/synthetic/image.png",
          contentType: "image/png",
          size: 100,
        },
      ],
    }),
  );
  assert.equal(sent.length, 4);
  assert.match(sent[3].text, /Commands cannot include attachments/);
  for (const { text } of sent)
    assert.doesNotMatch(text, /PRIVATE_PROMPT_SENTINEL|789abc/);
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshot(store), before);
});

test("!queue uses the saved thread runner, not the deployment default or a fresh readiness probe", async (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "private claude prompt", null, "claude");
  const { engine, sent, calls } = controls(t, store, { provider: "codex" });
  await engine.accept(message(20, "!queue"));
  assert.match(sent[0].text, /Claude Code; runner readiness unverified/);
  assert.match(
    nextLine(sent[0].text),
    /verify Claude Code login and configuration/,
  );
  assert.doesNotMatch(sent[0].text, /Codex/);
  assert.deepEqual(calls, []);
  assert.equal(store.get(id(1)).status, "queued");
});

test("a normal message waiting in a blocked thread points to !queue and never starts the runner", async () => {
  const store = new Store(":memory:");
  store.enqueue(id(1), thread, "original private instruction");
  store.claim();
  store.finish(
    id(1),
    "interrupted",
    "private partial response",
    "task_timeout",
  );
  const sent = [];
  let runs = 0;
  const engine = new Engine(
    config,
    store,
    {
      send: async (_thread, text) => sent.push(text),
      typing: async () => {},
    },
    {
      ready: async () => false,
      run: async () => {
        runs++;
        throw new Error("Blocked work must not run");
      },
      persist: async () => {},
      sync: async () => "clean",
    },
  );
  try {
    await engine.accept(message(2, "new private follow-up"));
    await engine.kick();
    engine.stop();
    assert.match(sent[0], /this message cannot run yet.*!queue/);
    assert.equal(store.get(id(2)).status, "queued");
    assert.equal(store.blockingJob(thread).id, id(1));
    assert.equal(runs, 0);
  } finally {
    engine.stop();
    await engine.kick();
    store.close();
  }
});

test("default !result selects the latest accepted task despite rollback and reversed IDs", async (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);
  const store = fixture(t);
  store.enqueue(id(9), thread, "older prompt");
  store.claim();
  store.finish(id(9), "succeeded", "OLDER_RESULT_SENTINEL");
  now = 1000;
  store.enqueue(id(1), thread, "newer prompt");
  store.claim();
  store.finish(id(1), "succeeded", "LATEST_RESULT_SENTINEL");
  const { engine, sent, calls } = controls(t, store);
  await engine.accept(message(20, "!result"));
  assert.match(sent[0].text, new RegExp(`^${id(1)}: succeeded`));
  assert.match(sent[0].text, /LATEST_RESULT_SENTINEL/);
  assert.doesNotMatch(sent[0].text, /OLDER_RESULT_SENTINEL/);
  assert.deepEqual(calls, []);
});
