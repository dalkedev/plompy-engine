import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../dist/store.js";

const thread = "920000000000000001";
const other = "920000000000000002";
const session = "01a12345-1234-7456-8456-123456789abc";
const id = (n) => String(910000000000000000n + BigInt(n));
const more = (summary = "First change verified") => ({
  outcome: "continue",
  summary,
  nextAction: "Verify the next bounded change",
});
const done = {
  outcome: "completed",
  summary: "All requested checks pass",
  nextAction: "",
};
const blocked = {
  outcome: "blocked",
  summary: "A required decision is missing",
  nextAction: "Ask the owner",
};
function fixture(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return store;
}
function state(store) {
  return Object.fromEntries(
    ["jobs", "conversations", "workflows", "workflow_steps", "effects"].map(
      (table) => [
        table,
        store.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(),
      ],
    ),
  );
}
function block(store) {
  return store.db
    .prepare("SELECT blocked_reason FROM conversations WHERE thread_id=?")
    .get(thread).blocked_reason;
}

test("workflow continuation yields fairly to another thread without allowing its own followup to overtake", (t) => {
  t.mock.method(Date, "now", () => 1000);
  const store = fixture(t);
  store.enqueueWorkflow(
    id(1),
    thread,
    "Implement the fixed original goal",
    60_000,
  );
  store.enqueue(id(2), thread, "Followup after the whole workflow");
  store.enqueue(id(3), other, "Unrelated ordinary work");
  const initial = store.get(id(1));
  assert.equal(store.claim().id, id(1));
  store.setSession(thread, session);
  assert.equal(store.claim(), undefined);
  assert.deepEqual(store.checkpoint(id(1), more(), 1234), {
    continued: true,
    status: "queued",
    reason: null,
  });
  assert.equal(store.get(id(1)).id, initial.id);
  assert.equal(store.get(id(1)).created_at, initial.created_at);
  assert.ok(store.get(id(1)).queued_at > store.get(id(3)).queued_at);
  assert.equal(store.session(thread), session);
  assert.equal(store.get(id(1)).result, more().summary);
  assert.equal(store.get(id(1)).finished_at, null);
  assert.equal(store.claim().id, id(3));
  store.finish(id(3), "succeeded", "done");
  assert.equal(store.claim().id, id(1));
  assert.deepEqual(store.checkpoint(id(1), done, 2000), {
    continued: false,
    status: "succeeded",
    reason: null,
  });
  assert.equal(store.workflow(id(1)).state, "completed");
  assert.equal(store.workflow(id(1)).elapsed_ms, 3234);
  assert.equal(store.workflow(id(1)).step_count, 2);
  assert.equal(store.workflowSteps(id(1)).length, 2);
  assert.equal(store.claim().id, id(2));
});

test("queue chooses original per-thread FIFO head before comparing fair queue positions", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "First in this thread");
  store.enqueue(id(2), thread, "Second in this thread");
  store.enqueue(id(3), other, "Other thread");
  store.db
    .prepare("UPDATE jobs SET created_at=10,queued_at=500 WHERE id=?")
    .run(id(1));
  store.db
    .prepare("UPDATE jobs SET created_at=20,queued_at=1 WHERE id=?")
    .run(id(2));
  store.db
    .prepare("UPDATE jobs SET created_at=30,queued_at=100 WHERE id=?")
    .run(id(3));
  assert.equal(store.claim().id, id(3));
  store.finish(id(3), "succeeded", "done");
  assert.equal(store.claim().id, id(1));
});

test("validated continuation exhausting time pauses without blocking or claiming overall completion", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "A substantial goal", 60_000);
  store.setSession(thread, session);
  store.enqueue(id(2), thread, "Ordinary followup remains eligible");
  store.claim();
  assert.deepEqual(store.checkpoint(id(1), more(), 60_000), {
    continued: false,
    status: "interrupted",
    reason: "workflow_budget_exhausted",
  });
  assert.equal(store.workflow(id(1)).state, "paused");
  assert.equal(block(store), null);
  assert.throws(
    () => store.recover(id(1), thread, id(3)),
    /new explicit !work budget/,
  );
  assert.equal(store.session(thread), session);
  assert.equal(store.claim().id, id(2));
  store.finish(id(2), "succeeded", "reply");
  store.enqueueWorkflow(
    id(4),
    thread,
    "Fresh explicit budget for remaining work",
    60_000,
  );
  assert.equal(store.claim().id, id(4));
  assert.equal(store.session(thread), session);
});

test("step cap bounds successful continuation and zero duration is charged one millisecond", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Bounded goal", 60_000, 2);
  store.claim();
  assert.equal(store.checkpoint(id(1), more(), 0).continued, true);
  assert.equal(store.workflow(id(1)).elapsed_ms, 1);
  store.claim();
  assert.deepEqual(store.checkpoint(id(1), more("Second checkpoint"), 0), {
    continued: false,
    status: "interrupted",
    reason: "workflow_step_limit",
  });
  assert.equal(store.workflow(id(1)).elapsed_ms, 2);
  assert.equal(store.workflow(id(1)).state, "paused");
  assert.equal(
    store.workflowSteps(id(1)).every((step) => step.elapsed_ms === 1),
    true,
  );
  assert.equal(block(store), null);
});

test("explicit completed and blocked outcomes take precedence over an elapsed budget", async (t) => {
  for (const outcome of [done, blocked])
    await t.test(outcome.outcome, (t) => {
      const store = fixture(t);
      store.enqueueWorkflow(id(1), thread, "Goal", 60_000, 1);
      store.claim();
      const result = store.checkpoint(id(1), outcome, 60_001);
      assert.equal(result.continued, false);
      assert.equal(
        store.workflow(id(1)).state,
        outcome.outcome === "completed" ? "completed" : "blocked",
      );
      assert.equal(
        block(store),
        outcome.outcome === "completed" ? null : "workflow_blocked",
      );
    });
});

test("blocked recovery keeps fixed goal, session, charged time and checkpoint log", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "The original owner goal", 120_000);
  store.setSession(thread, session);
  store.enqueue(id(2), thread, "Stale followup");
  store.claim();
  store.checkpoint(id(1), more(), 5000);
  store.claim();
  store.checkpoint(id(1), blocked, 7000);
  assert.equal(store.claim(), undefined);
  assert.equal(store.recover(id(1), thread, id(3)), true);
  const recovered = store.workflow(id(3));
  assert.equal(recovered.state, "active");
  assert.equal(recovered.goal, "The original owner goal");
  assert.equal(recovered.budget_ms, 120_000);
  assert.equal(recovered.elapsed_ms, 12_000);
  assert.equal(recovered.step_count, 2);
  assert.equal(recovered.last_summary, blocked.summary);
  assert.equal(recovered.next_action, blocked.nextAction);
  assert.equal(store.workflowSteps(id(3)).length, 2);
  assert.equal(store.get(id(2)).status, "cancelled");
  assert.equal(store.session(thread), session);
  assert.equal(block(store), null);
  assert.equal(store.workflow(id(1)).state, "blocked");
  assert.equal(store.claim().id, id(3));
  assert.match(store.get(id(3)).prompt, /Never blindly repeat a publication/);
});

test("recovering an ancestor cannot refund execution charged by a failed recovery", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Goal", 120_000);
  store.claim();
  store.finish(id(1), "failed", "partial", "turn_failed", 10_000);
  store.recover(id(1), thread, id(2));
  store.claim();
  store.checkpoint(id(2), more(), 20_000);
  store.claim();
  store.finish(id(2), "interrupted", "uncertain", "task_timeout", 30_000);
  assert.equal(store.workflow(id(2)).elapsed_ms, 60_000);
  store.recover(id(1), thread, id(3));
  assert.equal(store.workflow(id(3)).elapsed_ms, 60_000);
  assert.equal(store.workflow(id(3)).step_count, 1);
  assert.equal(store.workflow(id(3)).last_summary, more().summary);
  assert.equal(store.workflowSteps(id(3)).length, 1);
  store.claim();
  store.checkpoint(id(3), done, 10);
  assert.throws(
    () => store.recover(id(1), thread, id(4)),
    /already been successfully recovered/,
  );
});

test("uncertain workflow failure is charged, blocked and never implicitly replayed", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Goal", 60_000);
  store.enqueue(id(2), thread, "Must wait");
  store.claim();
  store.finish(
    id(1),
    "failed",
    "Partial actions possible",
    "invalid_workflow_output",
    250,
  );
  assert.equal(store.workflow(id(1)).state, "blocked");
  assert.equal(store.workflow(id(1)).elapsed_ms, 250);
  assert.equal(store.workflow(id(1)).step_count, 0);
  assert.equal(store.workflowSteps(id(1)).length, 0);
  assert.equal(store.claim(), undefined);
  assert.equal(store.get(id(2)).status, "queued");
  assert.notEqual(block(store), null);
  assert.equal(store.recoverStartup(), 0);
  assert.equal(store.get(id(1)).status, "failed");
});

test("startup consumes unknown running workflow allowance but preserves queued work and checkpoints", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Goal", 60_000);
  store.claim();
  store.checkpoint(id(1), more(), 1000);
  store.claim();
  store.enqueue(id(2), thread, "Must remain pending");
  const before = store.workflow(id(1));
  assert.equal(store.recoverStartup(), 1);
  assert.equal(store.get(id(1)).error_code, "process_restarted");
  assert.equal(store.workflow(id(1)).state, "blocked");
  assert.equal(store.workflow(id(1)).elapsed_ms, before.budget_ms);
  assert.equal(store.workflow(id(1)).last_summary, before.last_summary);
  assert.equal(store.workflow(id(1)).step_count, before.step_count);
  assert.equal(store.get(id(2)).status, "queued");
  assert.throws(
    () => store.recover(id(1), thread, id(3)),
    /new explicit !work budget/,
  );
  assert.equal(store.claim(), undefined);
});

test("startup preserves a verified queued workflow checkpoint and its remaining allowance", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Goal", 60_000);
  store.claim();
  store.checkpoint(id(1), more(), 1000);
  const before = store.workflow(id(1));
  const steps = store.workflowSteps(id(1));
  assert.equal(store.recoverStartup(), 0);
  assert.deepEqual(store.workflow(id(1)), before);
  assert.deepEqual(store.workflowSteps(id(1)), steps);
  assert.equal(store.claim().id, id(1));
});

test("cancel and session reset cancel workflow state atomically", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Cancel", 60_000);
  assert.equal(store.cancel(id(1), other), false);
  assert.equal(store.cancel(id(1), thread), true);
  assert.equal(store.workflow(id(1)).state, "cancelled");
  store.enqueueWorkflow(id(2), thread, "Reset", 60_000);
  store.setSession(thread, session);
  store.resetSession(thread);
  assert.equal(store.workflow(id(2)).state, "cancelled");
  assert.equal(store.get(id(2)).error_code, "owner_started_new_session");
  assert.equal(store.session(thread), null);
});

test("checkpoint, job state, block and dirty generation roll back together", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Goal", 60_000);
  store.claim();
  const before = state(store);
  store.db
    .exec(`CREATE TEMP TRIGGER reject_checkpoint_effect BEFORE UPDATE ON effects
    BEGIN SELECT RAISE(ABORT,'injected dirty failure'); END`);
  assert.throws(
    () => store.checkpoint(id(1), blocked, 123),
    /injected dirty failure/,
  );
  assert.deepEqual(state(store), before);
  store.db.exec("DROP TRIGGER reject_checkpoint_effect");
  assert.equal(
    store.checkpoint(id(1), blocked, 123).reason,
    "workflow_blocked",
  );
});

test("invalid checkpoints and durations preserve ownership and data", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Goal", 60_000);
  store.claim();
  const before = state(store);
  for (const outcome of [
    null,
    {},
    { ...more(), extra: "no" },
    { ...more(), summary: " " },
    { ...more(), nextAction: "" },
    { ...more(), summary: "😀".repeat(1001) },
    { ...more(), nextAction: "😀".repeat(1001) },
    { ...more(), outcome: "retry" },
  ]) {
    assert.throws(
      () => store.checkpoint(id(1), outcome, 1),
      /Invalid workflow checkpoint/,
    );
    assert.deepEqual(state(store), before);
  }
  for (const time of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => store.checkpoint(id(1), more(), time),
      /Invalid elapsed/,
    );
    assert.throws(
      () => store.finish(id(1), "failed", "", "failure", time),
      /Invalid elapsed/,
    );
    assert.deepEqual(state(store), before);
  }
  assert.throws(
    () => store.finish(id(1), "succeeded", "bypass schema"),
    /requires a checkpoint/,
  );
  assert.deepEqual(state(store), before);
  assert.equal(store.checkpoint(id(1), done, 1).status, "succeeded");
});

test("invalid workflow intake and queue capacity never leave partial workflow rows", (t) => {
  const store = fixture(t);
  for (const [goal, budget, steps] of [
    ["", 60_000, 32],
    ["Goal", 59_999, 32],
    ["Goal", 7_200_001, 32],
    ["Goal", 60_000, 0],
    ["Goal", 60_000, 33],
    ["Goal", NaN, 32],
  ]) {
    assert.throws(
      () => store.enqueueWorkflow(id(1), thread, goal, budget, steps),
      /Invalid work/,
    );
    assert.equal(store.get(id(1)), undefined);
    assert.equal(store.workflow(id(1)), undefined);
  }
  for (let n = 1; n <= 8; n++)
    store.enqueue(id(n), thread, "Existing queue slot");
  assert.throws(
    () => store.enqueueWorkflow(id(9), thread, "Full", 60_000),
    /Queue is full/,
  );
  assert.equal(store.workflow(id(9)), undefined);
  assert.equal(store.get(id(9)), undefined);
  assert.equal(
    store.enqueueWorkflow(id(1), thread, "Duplicate", 60_000),
    false,
  );
  assert.equal(store.workflow(id(1)), undefined);
});

test("failed recovery transaction preserves original workflow and queued followups", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Goal", 60_000);
  store.claim();
  store.checkpoint(id(1), blocked, 1000);
  store.enqueueWorkflow(id(2), thread, "Queued secondary workflow", 60_000);
  const before = state(store);
  store.db.exec(`CREATE TEMP TRIGGER reject_recovery BEFORE INSERT ON workflows
    WHEN NEW.job_id='${id(3)}' BEGIN SELECT RAISE(ABORT,'injected recovery failure'); END`);
  assert.throws(
    () => store.recover(id(1), thread, id(3)),
    /injected recovery failure/,
  );
  assert.deepEqual(state(store), before);
});

test("fresh-budget reconciliation retains provider and session while recording a separate budget", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Original goal", 60_000, 32, "claude");
  store.claim(["claude"]);
  store.setSession(thread, session, "claude");
  store.finish(id(1), "interrupted", "Uncertain", "task_timeout", 60_000);
  store.enqueue(id(2), thread, "Queued old followup");
  assert.equal(
    store.recover(id(1), thread, id(3), {
      work: { goal: "Current owner goal", budgetMs: 120_000 },
    }),
    true,
  );
  assert.equal(store.get(id(3)).provider, "claude");
  assert.equal(store.get(id(3)).recovery_of, id(1));
  assert.equal(store.session(thread), session);
  assert.equal(store.workflow(id(1)).elapsed_ms, 60_000);
  assert.equal(store.workflow(id(3)).elapsed_ms, 0);
  assert.equal(store.workflow(id(3)).step_count, 0);
  assert.equal(store.workflow(id(3)).budget_ms, 120_000);
  assert.equal(store.get(id(2)).error_code, "superseded_by_recovery");
});

test("invalid new recovery budget and insertion failure roll back queue cancellation and session state", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Original", 60_000);
  store.claim();
  store.finish(id(1), "interrupted", "partial", "task_timeout", 60_000);
  store.enqueue(id(2), thread, "Preserve until commit");
  const before = state(store);
  for (const work of [
    { goal: " ", budgetMs: 60_000 },
    { goal: "Goal", budgetMs: 1 },
    { goal: "Goal", budgetMs: 7_200_001 },
  ]) {
    assert.throws(() => store.recover(id(1), thread, id(3), { work }));
    assert.deepEqual(state(store), before);
  }
  store.db
    .exec(`CREATE TEMP TRIGGER reject_recovery_budget BEFORE INSERT ON workflows
    WHEN NEW.job_id='${id(3)}' BEGIN SELECT RAISE(ABORT,'injected new budget failure'); END`);
  assert.throws(
    () =>
      store.recover(id(1), thread, id(3), {
        work: { goal: "Continue safely", budgetMs: 120_000 },
      }),
    /injected new budget failure/,
  );
  assert.deepEqual(state(store), before);
});

test("blocking task resolution ignores queued followups and resolved recovery ancestors", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "Original");
  store.claim();
  store.finish(id(1), "interrupted", "partial", "task_timeout");
  store.enqueue(id(2), thread, "Newer queued request");
  assert.equal(store.blockingJob(thread).id, id(1));
  assert.equal(store.blockingJob(other), undefined);
  store.recover(id(1), thread, id(3));
  store.claim();
  store.finish(id(3), "succeeded", "Reconciled");
  store.db
    .prepare(
      "UPDATE conversations SET blocked_reason='stale' WHERE thread_id=?",
    )
    .run(thread);
  assert.equal(store.blockingJob(thread), undefined);
});

test("ancestor recovery follows the latest authorized fresh budget even after clock rollback", (t) => {
  const store = fixture(t);
  store.enqueueWorkflow(id(1), thread, "Old goal", 60_000);
  store.claim();
  store.finish(
    id(1),
    "interrupted",
    "Old partial result",
    "task_timeout",
    60_000,
  );
  store.recover(id(1), thread, id(2), {
    work: { goal: "New authorized goal", budgetMs: 120_000 },
  });
  store.claim();
  store.finish(
    id(2),
    "interrupted",
    "Latest uncertain result",
    "task_timeout",
    20_000,
  );
  store.db
    .prepare("UPDATE jobs SET created_at=0,finished_at=0 WHERE id=?")
    .run(id(2));
  assert.equal(store.blockingJob(thread).id, id(2));
  store.recover(id(1), thread, id(3));
  assert.equal(store.workflow(id(3)).goal, "New authorized goal");
  assert.equal(store.workflow(id(3)).budget_ms, 120_000);
  assert.equal(store.workflow(id(3)).elapsed_ms, 20_000);
  assert.equal(store.workflow(id(1)).elapsed_ms, 60_000);
});
