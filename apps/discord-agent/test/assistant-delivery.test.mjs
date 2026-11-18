import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ReminderScheduler } from "../dist/assistant-delivery.js";
import { AssistantStore } from "../dist/assistant-store.js";

const threadId = "100000000000000001";
const receiptId = "100000000000000002";
const dueAt = Date.parse("2030-01-02T09:30:00Z");
const maxLatenessMs = 30 * 60_000;

function claim(overrides = {}) {
  return {
    id: "r-123",
    version: 1,
    token: "test-lease",
    text: "Water the fern",
    dueAt,
    zone: "Europe/Warsaw",
    attempt: 1,
    ...overrides,
  };
}

function reminderScheduler(store, send, overrides = {}) {
  return new ReminderScheduler(store, send, {
    threadId,
    locale: "en",
    maxLatenessMs,
    now: () => dueAt,
    ...overrides,
  });
}

test("reminders start independently of a busy runner and ticks share one in-flight send", async () => {
  const pendingRunner = Promise.withResolvers();
  const dispatchStarted = Promise.withResolvers();
  const pendingSend = Promise.withResolvers();
  let runnerFinished = false;
  const runner = pendingRunner.promise.then(() => {
    runnerFinished = true;
  });
  const original = claim();
  const now = dueAt + 120_000;
  const events = [];
  const store = {
    recoverDeliveries(at) {
      events.push(["recover", at]);
    },
    claimDue(at, lateness) {
      events.push(["claim", at, lateness]);
      return original;
    },
    beginDelivery(value, at) {
      events.push(["begin", value, at]);
      return true;
    },
    finishDelivery(value, outcome, at) {
      events.push(["finish", value, outcome, at]);
    },
  };
  const scheduler = reminderScheduler(
    store,
    (target, content) => {
      dispatchStarted.resolve({ target, content });
      return pendingSend.promise;
    },
    { locale: "pl", now: () => now },
  );
  try {
    scheduler.start();
    const { target, content } = await dispatchStarted.promise;
    assert.equal(target, threadId);
    assert.match(content, /Opóźnione przypomnienie r-123/);
    assert.match(content, /10:30 \(Europe\/Warsaw\)/);
    assert.match(content, /Water the fern/);
    assert.equal(runnerFinished, false);
    const first = scheduler.tick();
    assert.equal(first, scheduler.tick());
    const shuttingDown = scheduler.stop();
    pendingSend.resolve({ kind: "sent", messageId: receiptId });
    await shuttingDown;
    await first;
    await scheduler.tick();
    assert.deepEqual(events, [
      ["recover", now],
      ["claim", now, maxLatenessMs],
      ["begin", original, now],
      ["finish", original, { kind: "sent", messageId: receiptId }, now],
    ]);
  } finally {
    pendingSend.resolve({ kind: "sent", messageId: receiptId });
    await scheduler.stop();
    pendingRunner.resolve();
    await runner;
  }
});

test("a cancelled or rescheduled claim cannot reach the transport", async () => {
  const original = claim();
  let reservations = 0;
  const scheduler = reminderScheduler(
    {
      claimDue: () => (reservations++ === 0 ? original : null),
      beginDelivery(value) {
        assert.equal(value, original);
        return false;
      },
      finishDelivery: () =>
        assert.fail("A superseded claim must not be finished"),
    },
    () => assert.fail("A superseded claim must not be sent"),
  );
  await scheduler.tick();
  assert.equal(reservations, 2);
});

test("explicitly rejected sends honor Retry-After and stop after three attempts", async () => {
  let now = dueAt;
  let availableAt = dueAt;
  let attempts = 0;
  const outcomes = [];
  const scheduler = reminderScheduler(
    {
      claimDue: (at) =>
        at >= availableAt && attempts < 3
          ? claim({ attempt: attempts + 1 })
          : null,
      beginDelivery() {
        attempts++;
        return true;
      },
      finishDelivery(_, outcome) {
        outcomes.push(outcome);
        if (outcome.kind === "retry") availableAt = outcome.retryAt;
      },
    },
    async () =>
      attempts === 1
        ? { kind: "retry", retryAfterMs: 50_000 }
        : { kind: "retry" },
    { now: () => now },
  );
  await scheduler.tick();
  now += 49_999;
  await scheduler.tick();
  assert.equal(attempts, 1);
  now++;
  await scheduler.tick();
  assert.equal(attempts, 2);
  now += 30_000;
  await scheduler.tick();
  assert.equal(attempts, 3);
  assert.deepEqual(outcomes, [
    { kind: "retry", retryAt: dueAt + 50_000 },
    { kind: "retry", retryAt: dueAt + 80_000 },
    { kind: "failed" },
  ]);
});

test("transport errors of unknown outcome are recorded as ambiguous without retry", async () => {
  let pending = claim();
  const outcomes = [];
  const scheduler = reminderScheduler(
    {
      claimDue() {
        const current = pending;
        pending = null;
        return current;
      },
      beginDelivery: () => true,
      finishDelivery: (_, outcome) => outcomes.push(outcome),
    },
    async () => {
      throw new Error("Connection closed before acknowledgement");
    },
  );
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(outcomes, [{ kind: "ambiguous" }]);
});

test("definitive rate limits beyond the configured lateness window end the attempt", async () => {
  let pending = claim();
  const outcomes = [];
  const scheduler = reminderScheduler(
    {
      claimDue() {
        const current = pending;
        pending = null;
        return current;
      },
      beginDelivery: () => true,
      finishDelivery: (_, outcome) => outcomes.push(outcome),
    },
    async () => ({ kind: "retry", retryAfterMs: 7200_000 }),
  );
  await scheduler.tick();
  assert.deepEqual(outcomes, [{ kind: "failed" }]);
});

test("a poll sends at most four reminders so a backlog cannot flood a thread at once", async () => {
  let sends = 0;
  const scheduler = reminderScheduler(
    {
      claimDue: () => claim(),
      beginDelivery: () => true,
      finishDelivery() {},
    },
    async () => {
      sends++;
      return { kind: "sent", messageId: receiptId };
    },
  );
  await scheduler.tick();
  assert.equal(sends, 4);
});

test("a new scheduler delivers recent persisted reminders and expires older ones", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "plompy-reminder-test-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "assistant.sqlite");
  const scope = {
    ownerId: "100000000000000003",
    threadId,
    zone: "Europe/Warsaw",
  };
  const now = dueAt + 60_000;
  let store = new AssistantStore(path, scope);
  try {
    const staleAt = dueAt - maxLatenessMs;
    store.execute(
      "100000000000000004",
      {
        kind: "reminder-set",
        dueAt: staleAt,
        text: "Old reminder",
      },
      staleAt - 60_000,
    );
    store.execute(
      "100000000000000005",
      {
        kind: "reminder-set",
        dueAt,
        text: "Recent reminder",
      },
      dueAt - 60_000,
    );
  } finally {
    store.close();
  }

  const messages = [];
  const send = async (target, content) => {
    messages.push({ target, content });
    return { kind: "sent", messageId: receiptId };
  };
  store = new AssistantStore(path, scope);
  try {
    await reminderScheduler(store, send, { now: () => now }).tick();
  } finally {
    store.close();
  }

  store = new AssistantStore(path, scope);
  try {
    await reminderScheduler(store, send, { now: () => now }).tick();
    const records = store.execute(
      "100000000000000006",
      { kind: "reminders" },
      now,
    );
    assert.equal(records.kind, "reminders");
    assert.deepEqual(
      Object.fromEntries(
        records.items.map(({ text, status }) => [text, status]),
      ),
      { "Old reminder": "expired", "Recent reminder": "sent" },
    );
  } finally {
    store.close();
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].target, threadId);
  assert.match(messages[0].content, /Delayed reminder R2/);
  assert.match(messages[0].content, /Recent reminder/);
});
