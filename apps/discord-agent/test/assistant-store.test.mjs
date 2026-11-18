import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AssistantStore,
  ASSISTANT_SCHEMA_VERSION,
} from "../dist/assistant-store.js";

const scope = {
  ownerId: "910000000000000001",
  threadId: "920000000000000001",
  zone: "Europe/Warsaw",
};
const now = Date.parse("2030-02-20T12:00:00Z");
const minute = 60_000;
const source = (n) => String(930000000000000000n + BigInt(n));

function file(t) {
  const dir = mkdtempSync(join(tmpdir(), "plompy-assistant-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "assistant.sqlite");
}

function reminder(store, index, dueAt = now + minute) {
  return store.execute(
    source(index),
    { kind: "reminder-set", text: `Test reminder ${index}`, dueAt },
    now,
  );
}

function status(store, index) {
  const result = store.execute(source(index), { kind: "reminders" }, now);
  assert.equal(result.kind, "reminders");
  return Object.fromEntries(
    result.items.map((entry) => [entry.id, entry.status]),
  );
}

test("notes, untimed tasks, and missing reminder details persist across restart", (t) => {
  const path = file(t);
  let store = new AssistantStore(path, scope);
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(
      store.execute(
        source(1),
        { kind: "note-add", text: "Plan: ZŁÓŻ wygodny stojak" },
        now,
      ),
      { kind: "note_saved", id: "N1" },
    );
    assert.deepEqual(
      store.execute(
        source(2),
        { kind: "task-add", text: "Wash the brushes" },
        now,
      ),
      { kind: "task_added", id: "T1" },
    );
    const first = store.execute(
      source(3),
      {
        kind: "reminder-question",
        text: "Bring the brushes",
        date: "2030-02-21",
      },
      now,
    );
    assert.equal(first.item.id, "Q1");
  } finally {
    store.close();
  }
  store = new AssistantStore(path, scope);
  t.after(() => store.close());
  assert.equal(
    store.execute(source(1), { kind: "note-add", text: "Replay" }, now),
    null,
  );
  const notes = store.execute(source(4), { kind: "notes", query: "złóż" }, now);
  assert.deepEqual(
    notes.items.map((entry) => entry.id),
    ["N1"],
  );
  assert.deepEqual(
    store.execute(source(5), { kind: "notes", query: "%" }, now).items,
    [],
  );
  const tasks = store.execute(source(6), { kind: "tasks" }, now);
  assert.equal(tasks.items[0].dueAt, null);
  assert.deepEqual(store.execute(source(7), { kind: "task-done" }, now), {
    kind: "task_done",
    id: "T1",
  });
  assert.deepEqual(store.execute(source(8), { kind: "tasks" }, now).items, []);
  const scheduled = store.execute(
    source(9),
    { kind: "reminder-answer", time: "14:30" },
    now,
  );
  assert.equal(scheduled.kind, "reminder_saved");
  assert.equal(scheduled.item.text, "Bring the brushes");
  assert.equal(scheduled.item.dueAt, Date.parse("2030-02-21T13:30:00Z"));
  assert.equal(
    store.execute(source(9), { kind: "reminder-answer", time: "14:30" }, now),
    null,
  );
  assert.deepEqual(
    store.execute(
      source(10),
      { kind: "reminder-answer", questionId: "Q1", time: "14:30" },
      now,
    ),
    { kind: "problem", code: "no_question" },
  );
  assert.deepEqual(
    store.execute(source(11), { kind: "questions" }, now).items,
    [],
  );
  assert.equal(
    store.execute(source(12), { kind: "reminders" }, now).items.length,
    1,
  );
});

test("independent questions require an explicit selection and reject expired answers", (t) => {
  const store = new AssistantStore(file(t), scope);
  t.after(() => store.close());
  store.execute(
    source(1),
    { kind: "reminder-question", text: "Start kiln", date: "2030-02-21" },
    now,
  );
  store.execute(
    source(2),
    { kind: "task-add", text: "Refill the water bottle" },
    now,
  );
  store.execute(
    source(3),
    { kind: "reminder-question", text: "Pack apron", date: "2030-02-22" },
    now,
  );
  assert.deepEqual(
    store.execute(source(4), { kind: "reminder-answer", time: "18:00" }, now),
    { kind: "problem", code: "multiple_questions" },
  );
  assert.deepEqual(
    store.execute(source(5), { kind: "question-cancel", id: "Q1" }, now),
    { kind: "question_cancelled", id: "Q1" },
  );
  assert.deepEqual(
    store.execute(
      source(6),
      { kind: "reminder-answer", questionId: "Q1", time: "18:00" },
      now,
    ),
    { kind: "problem", code: "no_question" },
  );
  assert.deepEqual(
    store.execute(
      source(7),
      { kind: "reminder-answer", time: "18:00" },
      Date.parse("2030-02-23T00:00:00Z"),
    ),
    { kind: "problem", code: "invalid_time" },
  );
  assert.deepEqual(
    store
      .execute(source(8), { kind: "questions" }, now)
      .items.map((item) => item.id),
    ["Q2"],
  );
  assert.equal(
    store.execute(
      source(9),
      {
        kind: "reminder-answer",
        questionId: "Q2",
        date: "2030-02-24",
        time: "18:00",
      },
      Date.parse("2030-02-23T00:00:00Z"),
    ).kind,
    "reminder_saved",
  );
});

test("a direct reminder move invalidates a pending question about the old time", (t) => {
  const store = new AssistantStore(file(t), scope);
  t.after(() => store.close());
  assert.equal(reminder(store, 1).kind, "reminder_saved");
  store.execute(
    source(2),
    { kind: "reminder-question", id: "R1", date: "2030-02-21" },
    now,
  );
  assert.equal(
    store.execute(
      source(3),
      { kind: "reminder-move", id: "R1", dueAt: now + 2 * minute },
      now,
    ).item.version,
    2,
  );
  assert.deepEqual(
    store.execute(
      source(4),
      { kind: "reminder-answer", questionId: "Q1", time: "18:00" },
      now,
    ),
    { kind: "problem", code: "no_question" },
  );
});

test("cancel and move invalidate reserved occurrences before dispatch", (t) => {
  const path = file(t);
  const first = new AssistantStore(path, scope);
  const second = new AssistantStore(path, scope);
  t.after(() => {
    first.close();
    second.close();
  });
  const due = now + minute;
  reminder(first, 1);
  const claim = first.claimDue(due, minute);
  assert.equal(claim.id, "R1");
  assert.equal(second.claimDue(due, minute), null);
  assert.equal(
    second.execute(
      source(2),
      { kind: "reminder-move", id: "R1", dueAt: due + minute },
      due,
    ).item.version,
    2,
  );
  assert.equal(first.beginDelivery(claim, due), false);
  assert.equal(second.claimDue(due, minute), null);
  const moved = second.claimDue(due + minute, minute);
  assert.equal(moved.version, 2);
  assert.equal(moved.attempt, 1);
  assert.equal(
    first.execute(
      source(3),
      { kind: "reminder-cancel", id: "R1" },
      due + minute,
    ).kind,
    "reminder_cancelled",
  );
  assert.equal(second.beginDelivery(moved, due + minute), false);
  assert.equal(first.claimDue(due + minute, minute), null);
});

test("reclaiming an abandoned reservation preserves the retry count, but in-flight sends are not replayed", (t) => {
  const path = file(t);
  const due = now + minute;
  let store = new AssistantStore(path, scope);
  reminder(store, 1);
  const reservation = store.claimDue(due, minute);
  store.close();
  store = new AssistantStore(path, scope);
  assert.equal(store.claimDue(due + 10_000, minute), null);
  const recovered = store.claimDue(due + 31_000, minute);
  assert.equal(recovered.attempt, 1);
  assert.notEqual(recovered.token, reservation.token);
  assert.equal(store.beginDelivery(reservation, due + 31_000), false);
  assert.equal(store.beginDelivery(recovered, due + 31_000), true);
  assert.deepEqual(
    store.execute(
      source(2),
      { kind: "reminder-cancel", id: "R1" },
      due + 32_000,
    ),
    { kind: "problem", code: "conflict" },
  );
  store.close();
  store = new AssistantStore(path, scope);
  t.after(() => store.close());
  store.recoverDeliveries(due + 60_000);
  assert.deepEqual(status(store, 3), { R1: "sending" });
  assert.equal(store.claimDue(due + 152_000, 5 * minute), null);
  assert.deepEqual(status(store, 4), { R1: "ambiguous" });
});

test("known failures retry after the specified delay and older undelivered appointments expire", (t) => {
  const path = file(t);
  const store = new AssistantStore(path, scope);
  t.after(() => store.close());
  reminder(store, 1);
  reminder(store, 2, now + 4 * minute);
  const due = now + 4 * minute;
  const first = store.claimDue(due, minute);
  assert.equal(first.id, "R2");
  assert.deepEqual(status(store, 3), { R2: "claimed", R1: "expired" });
  assert.equal(store.beginDelivery(first, due), true);
  store.finishDelivery(first, { kind: "retry", retryAt: due + 10_000 }, due);
  assert.equal(store.claimDue(due + 9_000, minute), null);
  const retried = store.claimDue(due + 10_000, minute);
  assert.equal(retried.attempt, 2);
  assert.equal(store.beginDelivery(retried, due + 10_000), true);
  const messageId = source(100);
  store.finishDelivery(retried, { kind: "sent", messageId }, due + 11_000);
  assert.equal(store.claimDue(due + 12_000, minute), null);
  assert.deepEqual(status(store, 4), { R2: "sent", R1: "expired" });
  const inspection = new DatabaseSync(path, { readOnly: true });
  t.after(() => inspection.close());
  assert.equal(
    inspection
      .prepare("SELECT message_id FROM assistant_outbox WHERE state='sent'")
      .get().message_id,
    messageId,
  );
});

test("unsupported schema or another owner/thread cannot alter existing state", (t) => {
  const path = file(t);
  const store = new AssistantStore(path, scope);
  reminder(store, 1);
  store.close();
  assert.throws(
    () => new AssistantStore(path, { ...scope, threadId: source(1) }),
    /bound to another owner or thread/,
  );
  const next = new DatabaseSync(path);
  next.exec(`PRAGMA user_version=${ASSISTANT_SCHEMA_VERSION + 1}`);
  next.close();
  assert.throws(
    () => new AssistantStore(path, scope),
    /Unsupported assistant database schema/,
  );
  const inspection = new DatabaseSync(path);
  t.after(() => inspection.close());
  assert.equal(
    inspection.prepare("SELECT count(*) as n FROM assistant_reminders").get().n,
    1,
  );
  assert.equal(
    inspection.prepare("PRAGMA user_version").get().user_version,
    ASSISTANT_SCHEMA_VERSION + 1,
  );
});

test("assistant setup does not adopt an existing database with unrelated tables", (t) => {
  const path = file(t);
  const existing = new DatabaseSync(path);
  chmodSync(path, 0o600);
  t.after(() => existing.close());
  existing.exec(
    "CREATE TABLE jobs(id TEXT); INSERT INTO jobs VALUES ('legacy-task')",
  );
  assert.throws(
    () => new AssistantStore(path, scope),
    /contains unrelated state/,
  );
  assert.equal(existing.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(existing.prepare("SELECT id FROM jobs").get().id, "legacy-task");
});
