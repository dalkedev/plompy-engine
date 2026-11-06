import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../dist/engine.js";
import { Store } from "../dist/store.js";
import { COMMAND_HELP, threadStatus } from "../dist/status.js";

const thread = "5555000000000000001";
const otherThread = "5555000000000000002";
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
function message(n, content, overrides = {}) {
  return {
    id: id(n),
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
function failed(store, number = 1) {
  store.enqueue(id(number), thread, "private owner instruction");
  assert.equal(store.claim().id, id(number));
  store.finish(
    id(number),
    "interrupted",
    "private saved response",
    "task_timeout",
  );
}
function nextLine(status) {
  return status.split("\n").find((line) => line.startsWith("Next:"));
}

test("status distinguishes an empty thread, idle worker and unverified login without creating a conversation", (t) => {
  const store = fixture(t);
  const text = threadStatus(store, thread, false);
  assert.match(text, /login unverified/);
  assert.match(text, /Session: not started/);
  assert.match(text, /0 queued; 0 running/);
  assert.match(text, /Worker: idle/);
  assert.match(text, /No tasks in this thread/);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM conversations").get().n,
    0,
  );
});

test("status shows local queue counts and shared worker occupancy without other-thread data or session IDs", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), otherThread, "foreign private prompt");
  store.claim();
  store.setSession(otherThread, "01a12345-1234-7456-8456-123456789def");
  store.enqueue(id(2), thread, "local private prompt");
  store.enqueue(id(3), thread, "another local private prompt");
  store.setSession(thread, session);
  const text = threadStatus(store, thread, true);
  assert.match(text, /Codex: authenticated/);
  assert.match(text, /Session: saved for this thread/);
  assert.match(text, /2 queued; 0 running/);
  assert.match(text, /Worker: busy in another thread/);
  assert.match(text, new RegExp(`${id(2)}: queued`));
  for (const privateValue of [
    otherThread,
    id(1),
    session,
    "foreign private",
    "local private",
    "789def",
  ])
    assert.ok(!text.includes(privateValue), privateValue);
  assert.match(nextLine(text), /wait for the worker/);
});

test("status labels a running task only in the thread that owns it", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "private prompt");
  store.claim();
  const text = threadStatus(store, thread, true);
  assert.match(text, /0 queued; 1 running/);
  assert.match(text, /Worker: running a task in this thread/);
  assert.match(nextLine(text), /wait for the current task/);
});

test("blocked queues name the newest failed recovery even when older failures are outside recent tasks", (t) => {
  const store = fixture(t);
  failed(store);
  store.recover(id(1), thread, id(2));
  store.claim();
  store.finish(id(2), "failed", "private partial result", "turn_failed");
  for (let n = 3; n <= 10; n++)
    store.enqueue(id(n), thread, `private follow-up ${n}`);
  const text = threadStatus(store, thread, true);
  assert.match(text, /blocked after a failed task/);
  assert.match(text, /8 queued; 0 running/);
  assert.match(nextLine(text), new RegExp(`!recover ${id(2)}`));
  assert.match(nextLine(text), /replaces queued follow-ups/);
  assert.ok(!text.includes("private"));
  assert.equal(store.get(id(2)).status, "failed");
});

test("an already queued or running manual recovery is reported instead of suggesting a duplicate", (t) => {
  const store = fixture(t);
  failed(store);
  store.recover(id(1), thread, id(2));
  for (const expected of ["queued", "running"]) {
    if (expected === "running") store.claim();
    const text = threadStatus(store, thread, true);
    assert.match(text, new RegExp(`${id(2)}: ${expected}`));
    assert.match(
      nextLine(text),
      /manual recovery is already queued or running/,
    );
    assert.doesNotMatch(nextLine(text), /!recover /);
  }
});

test("successful recovery descendants resolve the entire lineage and stale blocks recommend a new session", (t) => {
  const store = fixture(t);
  failed(store);
  store.recover(id(1), thread, id(2));
  store.claim();
  store.finish(id(2), "failed", "partial", "turn_failed");
  store.recover(id(2), thread, id(3));
  store.claim();
  store.finish(id(3), "succeeded", "reconciled");
  assert.doesNotMatch(nextLine(threadStatus(store, thread, true)), /!recover /);
  store.db
    .prepare(
      "UPDATE conversations SET blocked_reason='interrupted' WHERE thread_id=?",
    )
    .run(thread);
  const text = threadStatus(store, thread, true);
  assert.match(nextLine(text), /!new-session/);
  assert.match(nextLine(text), /No failed or interrupted task is eligible/);
  assert.doesNotMatch(nextLine(text), /!recover /);
});

test("uncertain response delivery points to the saved result and never exposes or retries it", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "do not repeat this action");
  store.claim();
  store.finish(id(1), "succeeded", "private result that must not be in status");
  store.notification(id(1), "ambiguous");
  const text = threadStatus(store, thread, true);
  assert.match(text, /response delivery uncertain/);
  assert.match(text, new RegExp(`!result ${id(1)}`));
  assert.match(text, /do not repeat the task/);
  assert.doesNotMatch(text, /private result|do not repeat this action/);
  assert.equal(store.get(id(1)).notification, "ambiguous");
});

test("status does not disclose arbitrary stored block text", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "fixture");
  store.db
    .prepare("UPDATE conversations SET blocked_reason=? WHERE thread_id=?")
    .run("/private/service/path secret", thread);
  const text = threadStatus(store, thread, true);
  assert.match(text, /owner action is required/);
  assert.doesNotMatch(text, /\/private|secret/);
});

test("authorized status/help commands are idempotent, read-only and do not start Codex", async (t) => {
  const store = fixture(t);
  const sent = [];
  const forbidden = async () => {
    throw new Error("Control commands must not start or persist work");
  };
  const engine = new Engine(
    config,
    store,
    {
      send: async (threadId, text) => sent.push({ threadId, text }),
      typing: forbidden,
    },
    { ready: forbidden, run: forbidden, persist: forbidden, sync: forbidden },
  );
  t.after(() => engine.stop());
  assert.equal(
    await engine.accept(
      message(1, "!status", { authorId: "999999999999999999" }),
    ),
    false,
  );
  assert.equal(sent.length, 0);
  await engine.accept(message(2, "!status"));
  await engine.accept(message(2, "!status"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, thread);
  assert.match(sent[0].text, /0 queued; 0 running/);
  await engine.accept(message(3, "!help"));
  assert.equal(sent[1].text, COMMAND_HELP);
  assert.match(sent[1].text, /queued task is not running yet/);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs").get().n, 0);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM conversations").get().n,
    0,
  );
});

test("unknown command typos explain syntax without accidentally queueing a task", async (t) => {
  const store = fixture(t);
  const sent = [];
  const forbidden = async () => {
    throw new Error("Unknown commands must not launch work");
  };
  const engine = new Engine(
    config,
    store,
    {
      send: async (_thread, text) => sent.push(text),
      typing: forbidden,
    },
    { ready: forbidden, run: forbidden, persist: forbidden, sync: forbidden },
  );
  t.after(() => engine.stop());
  await engine.accept(message(1, "!stats"));
  await engine.accept(message(1, "!stats"));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Unknown command.*!help.*Nothing was queued/);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM jobs").get().n, 0);
});

test("invalid control arguments cannot reset a session, cancel work, recover tasks or disclose results", async (t) => {
  const store = fixture(t);
  failed(store);
  store.setSession(thread, session);
  store.enqueue(id(2), thread, "queued follow-up to preserve");
  store.enqueue(id(3), otherThread, "unrelated queued task to preserve");
  const snapshot = () => ({
    jobs: store.db.prepare("SELECT * FROM jobs ORDER BY id").all(),
    conversations: store.db
      .prepare("SELECT * FROM conversations ORDER BY thread_id")
      .all(),
  });
  const before = snapshot();
  const sent = [];
  let dependencyCalls = 0;
  const forbidden = async () => {
    dependencyCalls++;
    throw new Error("Invalid commands must not launch or persist work");
  };
  const engine = new Engine(
    config,
    store,
    {
      send: async (_thread, text) => sent.push(text),
      typing: forbidden,
    },
    { ready: forbidden, run: forbidden, persist: forbidden, sync: forbidden },
  );
  t.after(() => engine.stop());
  const invalid = [
    ["!status extra", "!status"],
    ["!help extra", "!help"],
    ["!new-session extra", "!new-session"],
    ["!cancel", "!cancel <task ID>"],
    ["!cancel not-an-id", "!cancel <task ID>"],
    ["!cancel 123", "!cancel <task ID>"],
    [`!cancel ${id(2)} extra`, "!cancel <task ID>"],
    ["!result not-an-id", "!result [task ID]"],
    ["!result 123", "!result [task ID]"],
    [`!result ${id(1)} extra`, "!result [task ID]"],
  ];
  for (const [n, [content, usage]] of invalid.entries()) {
    const command = message(100 + n, content);
    await engine.accept(command);
    assert.equal(sent.length, n + 1);
    assert.ok(sent[n].startsWith(`Usage: ${usage}.`), content);
    assert.match(sent[n], /No action was taken and nothing was queued/);
    assert.doesNotMatch(sent[n], /private saved response/);
    assert.deepEqual(snapshot(), before, content);
    await engine.accept(command);
    assert.equal(
      sent.length,
      n + 1,
      "duplicate controls send only one usage response",
    );
  }
  assert.equal(dependencyCalls, 0);
  assert.equal(store.session(thread), session);
  assert.equal(store.get(id(2)).status, "queued");
});
