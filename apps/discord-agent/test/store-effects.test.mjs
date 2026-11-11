import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";
const thread = "920000000000000001",
  other = "920000000000000002";
const id = (n) => String(910000000000000000n + BigInt(n));
const session = "01a12345-1234-7456-8456-123456789abc";
function fixture(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return store;
}
function caughtUp(store, threadId = thread) {
  const g = store.effect(threadId).generation;
  store.completeEffect(threadId, g, "transcript");
  store.completeEffect(threadId, g, "memory");
}

test("every transcript mutation marks a durable generation and idempotent intake does not", (t) => {
  const store = fixture(t);
  assert.equal(store.effect(thread), undefined);
  store.enqueue(id(1), thread, "Queued");
  assert.equal(store.effect(thread).generation, 1);
  assert.equal(store.enqueue(id(1), thread, "duplicate"), false);
  assert.equal(store.effect(thread).generation, 1);
  store.claim();
  assert.equal(store.effect(thread).generation, 2);
  store.setSession(thread, session);
  assert.equal(store.effect(thread).generation, 3);
  store.setSession(thread, session);
  assert.equal(store.effect(thread).generation, 3);
  store.finish(id(1), "failed", "partial", "turn_failed");
  assert.equal(store.effect(thread).generation, 4);
  store.recover(id(1), thread, id(2));
  assert.equal(store.effect(thread).generation, 5);
  store.cancel(id(2), thread);
  assert.equal(store.effect(thread).generation, 6);
  store.resetSession(thread);
  assert.equal(store.effect(thread).generation, 7);
  assert.equal(store.pendingEffects().length, 1);
});

test("captured export and sync completion cannot swallow a newer generation", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "First");
  const captured = store.pendingEffects()[0];
  store.enqueue(id(2), thread, "Arrived while export was in flight");
  store.completeEffect(thread, captured.generation, "transcript");
  store.completeEffect(thread, captured.generation, "memory");
  assert.equal(store.effect(thread).exported_generation, 1);
  assert.equal(store.effect(thread).synced_generation, 1);
  assert.equal(store.effect(thread).generation, 2);
  assert.equal(store.pendingEffects()[0].generation, 2);
  caughtUp(store);
  assert.equal(store.pendingEffects().length, 0);
});

test("memory sync requires the captured transcript and rejects future or invalid generations", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "Goal");
  const before = store.effect(thread);
  assert.throws(
    () => store.completeEffect(thread, 1, "memory"),
    /Transcript must be exported/,
  );
  assert.deepEqual(store.effect(thread), before);
  for (const g of [0, -1, 1.1, 2, NaN, Infinity]) {
    assert.throws(
      () => store.completeEffect(thread, g, "transcript"),
      /Invalid effect generation/,
    );
    assert.throws(
      () => store.failEffect(thread, g, "memory_sync_failed"),
      /Invalid effect generation/,
    );
  }
  assert.throws(
    () => store.completeEffect(thread, 1, "invalid"),
    /Invalid effect kind/,
  );
  assert.throws(
    () => store.failEffect(thread, 1, "secret arbitrary failure body"),
    /Invalid effect error/,
  );
  assert.deepEqual(store.effect(thread), before);
});

test("retry backoff is bounded and errors are sanitized enums, then fully cleared after catch-up", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "Goal");
  for (let attempt = 1; attempt <= 15; attempt++) {
    store.failEffect(thread, 1, "transcript_export_failed", 1000);
    const effect = store.effect(thread);
    assert.equal(effect.attempts, attempt);
    assert.equal(
      effect.retry_at,
      1000 + Math.min(1000 * 2 ** (attempt - 1), 300_000),
    );
    assert.equal(store.pendingEffects(effect.retry_at - 1).length, 0);
    assert.equal(store.pendingEffects(effect.retry_at).length, 1);
    assert.equal(effect.last_error, "transcript_export_failed");
  }
  store.completeEffect(thread, 1, "transcript");
  assert.equal(store.effect(thread).last_error, "transcript_export_failed");
  store.failEffect(thread, 1, "memory_sync_blocked", 400_000);
  assert.equal(store.effect(thread).last_error, "memory_sync_blocked");
  store.completeEffect(thread, 1, "memory");
  assert.equal(store.effect(thread).last_error, null);
  assert.equal(store.effect(thread).retry_at, 0);
  assert.equal(store.effect(thread).attempts, 0);
  assert.equal(store.pendingEffects(999_999).length, 0);
});

test("new dirty data is immediately due and stale failures cannot postpone it", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "First");
  store.failEffect(thread, 1, "memory_sync_failed", 1000);
  assert.equal(store.pendingEffects(1001).length, 0);
  store.enqueue(id(2), thread, "New data");
  assert.equal(store.effect(thread).generation, 2);
  assert.equal(store.effect(thread).retry_at, 0);
  store.failEffect(thread, 1, "transcript_export_failed", 5000);
  assert.equal(store.effect(thread).retry_at, 0);
  assert.equal(store.effect(thread).attempts, 0);
  assert.equal(store.pendingEffects(1001)[0].generation, 2);
});

test("effects persist through restart without resetting a retry or rerunning completed model work", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plompy-effects-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.sqlite");
  let store = new Store(path);
  store.enqueue(id(1), thread, "Goal");
  store.claim();
  store.finish(id(1), "succeeded", "Saved result");
  const g = store.effect(thread).generation;
  store.completeEffect(thread, g, "transcript");
  store.failEffect(thread, g, "memory_sync_failed", 1000);
  const before = store.effect(thread);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.deepEqual(store.effect(thread), before);
  assert.equal(store.recoverStartup(), 0);
  assert.equal(store.claim(), undefined);
  assert.equal(store.get(id(1)).result, "Saved result");
  assert.equal(store.pendingEffects(1999).length, 0);
  assert.equal(store.pendingEffects(2000).length, 1);
});

test("dirty export insertion failure rolls back intake and claim/session changes", (t) => {
  const store = fixture(t);
  store.db.exec(`CREATE TEMP TRIGGER reject_new_effect BEFORE INSERT ON effects
   BEGIN SELECT RAISE(ABORT,'injected effect failure'); END`);
  assert.throws(
    () => store.enqueue(id(1), thread, "No partial intake"),
    /injected effect failure/,
  );
  assert.equal(store.get(id(1)), undefined);
  assert.equal(store.db.prepare("SELECT * FROM conversations").all().length, 0);
  store.db.exec("DROP TRIGGER reject_new_effect");
  store.enqueue(id(1), thread, "Goal");
  const generation = store.effect(thread).generation;
  store.db
    .exec(`CREATE TEMP TRIGGER reject_dirty_effect BEFORE UPDATE ON effects
   BEGIN SELECT RAISE(ABORT,'injected dirty failure'); END`);
  assert.throws(() => store.claim(), /injected dirty failure/);
  assert.equal(store.get(id(1)).status, "queued");
  assert.throws(
    () => store.setSession(thread, session),
    /injected dirty failure/,
  );
  assert.equal(store.session(thread), null);
  assert.equal(store.effect(thread).generation, generation);
  store.db.exec("DROP TRIGGER reject_dirty_effect");
  assert.equal(store.claim().id, id(1));
});

test("pending effects query is bounded and contains metadata only", (t) => {
  const store = fixture(t);
  for (let n = 1; n <= 3; n++)
    store.enqueue(
      id(n),
      String(920000000000000000n + BigInt(n)),
      `Private synthetic prompt ${n}`,
    );
  const rows = store.pendingEffects();
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "attempts",
    "exported_generation",
    "generation",
    "last_error",
    "retry_at",
    "synced_generation",
    "thread_id",
  ]);
  assert.equal(JSON.stringify(rows).includes("Private synthetic"), false);
  assert.equal(store.pendingEffects(Date.now(), 0).length, 0);
  assert.equal(store.pendingEffects(Date.now(), 3).length, 3);
});
