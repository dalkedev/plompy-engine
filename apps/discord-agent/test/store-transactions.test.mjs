import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../dist/store.js";

const thread = "920000000000000001";
const otherThread = "920000000000000002";
const sessionId = "01a12345-1234-7456-8456-123456789abc";
const id = (n) => String(910000000000000000n + BigInt(n));

function fixture(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return store;
}

function snapshot(store) {
  return {
    jobs: store.db.prepare("SELECT * FROM jobs ORDER BY id").all(),
    conversations: store.db
      .prepare("SELECT * FROM conversations ORDER BY thread_id")
      .all(),
  };
}

function failedOriginal(store) {
  store.enqueue(id(1), thread, "Inspect receipts before continuing work.");
  assert.equal(store.claim().id, id(1));
  store.finish(id(1), "failed", "Partial output", "turn_failed");
}

test("terminal status and the conversation block roll back together on a database failure", async (t) => {
  for (const status of ["failed", "interrupted"])
    await t.test(status, (t) => {
      const store = fixture(t);
      store.enqueue(id(1), thread, "original");
      store.enqueue(id(2), thread, "followup must not run after ambiguity");
      store.enqueue(id(3), otherThread, "unrelated work");
      store.claim();
      const before = snapshot(store);
      store.db.exec(`CREATE TEMP TRIGGER reject_block
        BEFORE UPDATE OF blocked_reason ON conversations
        WHEN NEW.blocked_reason IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'injected block failure'); END`);

      assert.throws(
        () => store.finish(id(1), status, "partial", "turn_failed"),
        /injected block failure/,
      );
      assert.deepEqual(snapshot(store), before);
      assert.equal(store.claim(), undefined);

      store.db.exec("DROP TRIGGER reject_block");
      store.finish(id(1), status, "partial", "turn_failed");
      assert.equal(store.get(id(1)).status, status);
      assert.equal(
        store.db
          .prepare("SELECT blocked_reason FROM conversations WHERE thread_id=?")
          .get(thread).blocked_reason,
        status,
      );
      assert.equal(store.claim().id, id(3));
      store.finish(id(3), "succeeded", "done");
      assert.equal(store.claim(), undefined);
      assert.equal(store.get(id(2)).status, "queued");
    });
});

test("lost finish ownership rolls back without leaving the connection in a transaction", (t) => {
  const store = fixture(t);
  failedOriginal(store);
  const before = snapshot(store);
  assert.throws(
    () => store.finish(id(1), "succeeded", "must not overwrite"),
    /Job ownership lost/,
  );
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.enqueue(id(2), otherThread, "next task"), true);
  assert.equal(store.claim().id, id(2));
});

test("session reset rolls back queued cancellations if clearing the mapping fails", (t) => {
  const store = fixture(t);
  failedOriginal(store);
  store.setSession(thread, sessionId);
  store.enqueue(id(2), thread, "keep until reset commits");
  store.enqueue(id(3), otherThread, "unrelated work");
  const before = snapshot(store);
  store.db.exec(`CREATE TEMP TRIGGER reject_reset
    BEFORE UPDATE OF session_id ON conversations
    WHEN NEW.session_id IS NULL
    BEGIN SELECT RAISE(ABORT,'injected reset failure'); END`);

  assert.throws(() => store.resetSession(thread), /injected reset failure/);
  assert.deepEqual(snapshot(store), before);

  store.db.exec("DROP TRIGGER reject_reset");
  store.resetSession(thread);
  assert.equal(store.session(thread), null);
  assert.equal(store.get(id(2)).status, "cancelled");
  assert.equal(store.get(id(2)).error_code, "owner_started_new_session");
  assert.equal(store.get(id(3)).status, "queued");
  assert.equal(store.claim().id, id(3));
});

test("session reset refuses a running turn and preserves all pending work", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "active");
  store.enqueue(id(2), thread, "queued");
  store.setSession(thread, sessionId);
  store.claim();
  const before = snapshot(store);
  assert.throws(() => store.resetSession(thread), /A turn is still running/);
  assert.deepEqual(snapshot(store), before);
  store.finish(id(1), "succeeded", "finished");
  store.resetSession(thread);
  assert.equal(store.get(id(2)).status, "cancelled");
});

test("a second recovery cannot replace a queued recovery or its queued followups", (t) => {
  const store = fixture(t);
  failedOriginal(store);
  assert.equal(store.recover(id(1), thread, id(2)), true);
  store.enqueue(id(3), thread, "followup after recovery request");
  const before = snapshot(store);

  assert.throws(
    () => store.recover(id(1), thread, id(4)),
    /A turn or recovery is already pending/,
  );
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.recover(id(1), thread, id(2)), false);
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.claim().id, id(2));
});

test("running recovery cannot overlap another recovery of the same original", (t) => {
  const store = fixture(t);
  failedOriginal(store);
  store.recover(id(1), thread, id(2));
  assert.equal(store.claim().id, id(2));
  store.enqueue(id(3), thread, "keep this followup");
  const before = snapshot(store);

  assert.throws(
    () => store.recover(id(1), thread, id(4)),
    /A turn or recovery is already pending/,
  );
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.recover(id(1), thread, id(2)), false);
  assert.deepEqual(snapshot(store), before);
  store.finish(id(2), "succeeded", "reconciled");
  assert.equal(store.claim().id, id(3));
});

test("an original with a successful recovery cannot be recovered again", (t) => {
  const store = fixture(t);
  failedOriginal(store);
  store.recover(id(1), thread, id(2));
  store.claim();
  store.finish(id(2), "succeeded", "publication confirmed");
  store.enqueue(id(3), thread, "ordinary followup");
  const before = snapshot(store);

  assert.throws(
    () => store.recover(id(1), thread, id(4)),
    /already been successfully recovered/,
  );
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.recover(id(1), thread, id(2)), false);
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.claim().id, id(3));
});

test("manual recovery follows failed recovery chains and closes every ancestor after success", (t) => {
  const store = fixture(t);
  failedOriginal(store);
  store.recover(id(1), thread, id(2));
  store.claim();
  store.finish(id(2), "failed", "still needs reconciliation", "turn_failed");
  assert.equal(store.recover(id(2), thread, id(3)), true);
  store.claim();
  store.finish(id(3), "interrupted", "partial", "task_timeout");
  assert.equal(store.recover(id(3), thread, id(4)), true);
  store.claim();
  store.finish(id(4), "succeeded", "reconciled once");
  const before = snapshot(store);

  for (const ancestor of [id(1), id(2), id(3)]) {
    assert.throws(
      () => store.recover(ancestor, thread, id(5)),
      /already been successfully recovered/,
    );
    assert.deepEqual(snapshot(store), before);
  }
});

test("failed or cancelled recovery attempts permit a new explicit recovery", (t) => {
  const store = fixture(t);
  failedOriginal(store);
  store.recover(id(1), thread, id(2));
  store.claim();
  store.finish(id(2), "failed", "not completed", "turn_failed");
  assert.equal(store.recover(id(1), thread, id(3)), true);
  assert.equal(store.cancel(id(3), thread), true);
  assert.equal(store.recover(id(1), thread, id(4)), true);
  assert.equal(store.claim().id, id(4));
});

test("an ordinary running turn in the same thread also prevents stale recovery", (t) => {
  const store = fixture(t);
  failedOriginal(store);
  store.resetSession(thread);
  store.enqueue(id(2), thread, "new session work");
  store.claim();
  store.enqueue(id(3), thread, "new session followup");
  const before = snapshot(store);

  assert.throws(
    () => store.recover(id(1), thread, id(4)),
    /A turn or recovery is already pending/,
  );
  assert.deepEqual(snapshot(store), before);
});

test("recovery guards are thread-local while claiming remains globally serialized", (t) => {
  const store = fixture(t);
  failedOriginal(store);
  store.enqueue(id(2), otherThread, "other active work");
  assert.equal(store.claim().id, id(2));
  const otherBefore = store.get(id(2));

  assert.equal(store.recover(id(1), thread, id(3)), true);
  assert.deepEqual(store.get(id(2)), otherBefore);
  assert.equal(store.claim(), undefined);
  store.finish(id(2), "succeeded", "other task done");
  assert.equal(store.claim().id, id(3));
});
