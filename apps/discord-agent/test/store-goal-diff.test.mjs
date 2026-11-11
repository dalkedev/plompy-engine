import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION } from "../dist/store.js";
import { repositorySnapshotHash } from "../dist/repository-diff.js";
const thread = "920000000000000001";
const other = "920000000000000002";
const id = (n) => String(910000000000000000n + BigInt(n));
const repository = "/synthetic/project";
const candidate = {
  outcome: "continue",
  summary: "Changed source",
  nextAction: "Check the result",
};
const completed = {
  outcome: "completed",
  summary: "Independent evidence verified",
  nextAction: "",
};
function snapshot(root = repository, text = "export const value = 1;\n") {
  const value = {
    version: 1,
    root,
    head: "a".repeat(40),
    capturedAt: new Date(0).toISOString(),
    files: [
      {
        path: "src/index.js",
        kind: "text",
        size: Buffer.byteLength(text),
        mode: 0o644,
        sha256: createHash("sha256").update(text).digest("hex"),
        text,
      },
    ],
    complete: true,
    omissions: [],
    contentHash: "",
  };
  value.contentHash = repositorySnapshotHash(value);
  return value;
}
function evidence(before = snapshot(), status = "complete") {
  return {
    version: 1,
    root: before.root,
    status,
    beforeHash: before.contentHash,
    afterHash: status === "unavailable" ? null : "b".repeat(64),
    beforeHead: before.head,
    afterHead: status === "unavailable" ? null : "c".repeat(40),
    changes: [],
    patch: "",
    omissions: [],
    note: "Synthetic observed source evidence",
    ...(status === "unavailable" ? { error: "repository_capture_failed" } : {}),
  };
}
function fixture(t, disk = false) {
  const dir = mkdtempSync(join(tmpdir(), "plompy-goal-code-"));
  const path = disk ? join(dir, "queue.sqlite") : ":memory:";
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path };
}
function start(store, n = 1, root = repository, goal = "Fix source") {
  store.enqueueGoal(id(n), thread, goal, 120000, "codex", root);
  assert.equal(store.claim().id, id(n));
}
function seal(store, n = 1, before = snapshot()) {
  store.saveGoalBaseline(id(n), JSON.stringify(before));
  store.saveGoalWorker(
    id(n),
    candidate,
    1234,
    JSON.stringify(evidence(before)),
  );
}
function originalRows(store) {
  return ["jobs", "workflows", "goals", "goal_code_evidence", "effects"].map(
    (table) => store.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(),
  );
}
function schema5(path) {
  const store = new Store(path);
  store.enqueueGoal(id(1), thread, "Legacy candidate", 120000);
  store.claim();
  store.saveGoalWorker(id(1), candidate, 1000);
  store.db.exec(
    "DROP TABLE goal_code_evidence; DROP TRIGGER preserve_goal_repository; ALTER TABLE goals DROP COLUMN repository_path; PRAGMA user_version=5; PRAGMA journal_mode=DELETE",
  );
  const old = store.db
    .prepare("SELECT * FROM goals")
    .all()
    .map((row) => ({ ...row }));
  store.close();
  return old;
}

test("repository-bound intake validates immutable canonical paths before mutation", (t) => {
  const { store } = fixture(t);
  for (const bad of [
    "relative",
    "/project/../other",
    "/project\nsecret",
    "x".repeat(5000),
    42,
  ]) {
    assert.throws(
      () => store.enqueueGoal(id(1), thread, "Goal", 60000, "codex", bad),
      /repository/,
    );
    assert.equal(store.get(id(1)), undefined);
    assert.equal(store.provider(thread), null);
  }
  start(store);
  assert.equal(store.goal(id(1)).repository_path, repository);
  assert.throws(
    () =>
      store.db
        .prepare("UPDATE goals SET repository_path=? WHERE job_id=?")
        .run("/other", id(1)),
    /immutable/,
  );
});

test("bound worker candidates require a matching baseline and atomic sealed evidence", (t) => {
  const { store } = fixture(t);
  start(store);
  const initial = originalRows(store);
  assert.throws(
    () => store.saveGoalWorker(id(1), candidate, 1234),
    /requires code evidence/,
  );
  assert.deepEqual(originalRows(store), initial);
  const before = snapshot();
  store.saveGoalBaseline(id(1), JSON.stringify(before));
  assert.equal(store.workflow(id(1)).elapsed_ms, 0);
  assert.equal(
    store.goalCodeEvidence(id(1)).before_snapshot,
    JSON.stringify(before),
  );
  const saved = originalRows(store);
  assert.throws(
    () =>
      store.saveGoalWorker(
        id(1),
        candidate,
        1234,
        JSON.stringify({ ...evidence(before), root: "/other" }),
      ),
    /baseline/,
  );
  assert.throws(
    () =>
      store.saveGoalWorker(
        id(1),
        candidate,
        1234,
        JSON.stringify({ ...evidence(before), beforeHash: "d".repeat(64) }),
      ),
    /baseline/,
  );
  assert.deepEqual(originalRows(store), saved);
  store.saveGoalWorker(
    id(1),
    candidate,
    1234,
    JSON.stringify(evidence(before)),
  );
  assert.equal(store.goal(id(1)).pending_output, JSON.stringify(candidate));
  assert.equal(store.workflow(id(1)).elapsed_ms, 1234);
  assert.equal(store.goalCodeEvidence(id(1)).before_snapshot, null);
  assert.equal(
    store.goalCodeEvidence(id(1)).evidence,
    JSON.stringify(evidence(before)),
  );
  assert.throws(
    () => store.saveGoalBaseline(id(1), JSON.stringify(before)),
    /ownership/,
  );
  assert.throws(
    () =>
      store.db
        .prepare("UPDATE goal_code_evidence SET evidence=? WHERE job_id=?")
        .run("{}", id(1)),
    /immutable/,
  );
});

test("unbound legacy goals reject invented code evidence and retain ordinary behavior", (t) => {
  const { store } = fixture(t);
  start(store, 1, null);
  assert.equal(store.goal(id(1)).repository_path, null);
  assert.throws(
    () => store.saveGoalBaseline(id(1), JSON.stringify(snapshot())),
    /ownership/,
  );
  assert.throws(
    () =>
      store.saveGoalWorker(id(1), candidate, 100, JSON.stringify(evidence())),
    /requires an owner-bound/,
  );
  store.saveGoalWorker(id(1), candidate, 100);
  assert.equal(store.goalCodeEvidence(id(1)), undefined);
  assert.equal(
    store.reviewGoal(id(1), completed, true, 100).status,
    "succeeded",
  );
});

test("effect persistence failure rolls candidate, budget and sealed evidence back together", (t) => {
  const { store } = fixture(t);
  start(store);
  store.saveGoalBaseline(id(1), JSON.stringify(snapshot()));
  const before = originalRows(store);
  store.db.exec(
    "CREATE TEMP TRIGGER reject_code_effect BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT,'injected code effect failure'); END",
  );
  assert.throws(
    () =>
      store.saveGoalWorker(id(1), candidate, 1234, JSON.stringify(evidence())),
    /injected/,
  );
  assert.deepEqual(originalRows(store), before);
  store.db.exec("DROP TRIGGER reject_code_effect");
  store.saveGoalWorker(id(1), candidate, 1234, JSON.stringify(evidence()));
  assert.equal(store.workflow(id(1)).elapsed_ms, 1234);
});

test("baseline capture is replaceable only while no worker candidate is saved", (t) => {
  const { store } = fixture(t);
  start(store);
  store.saveGoalBaseline(id(1), JSON.stringify(snapshot()));
  const newer = snapshot(repository, "export const value = 9;\n");
  store.saveGoalBaseline(id(1), JSON.stringify(newer));
  assert.equal(
    store.goalCodeEvidence(id(1)).before_snapshot,
    JSON.stringify(newer),
  );
  store.saveGoalWorker(id(1), candidate, 10, JSON.stringify(evidence(newer)));
  assert.throws(
    () => store.saveGoalBaseline(id(1), JSON.stringify(snapshot())),
    /ownership/,
  );
});

test("partial or unavailable evidence is explicit and survives safe pause and resume", (t) => {
  const { store } = fixture(t);
  start(store);
  const before = snapshot();
  store.saveGoalBaseline(id(1), JSON.stringify(before));
  store.saveGoalWorker(
    id(1),
    candidate,
    1000,
    JSON.stringify(evidence(before, "unavailable")),
  );
  store.requestGoalControl(id(1), thread, "pause");
  assert.equal(store.applyGoalControl(id(1)), true);
  const sealed = store.goalCodeEvidence(id(1));
  assert.equal(sealed.before_snapshot, JSON.stringify(before));
  assert.equal(store.resumeGoal(id(1), thread), true);
  store.claim();
  assert.deepEqual(store.goalCodeEvidence(id(1)), sealed);
  assert.equal(store.workflow(id(1)).elapsed_ms, 1000);
});

test("reviewer recovery reuses sealed evidence and accumulated reviewed history", (t) => {
  const { store } = fixture(t);
  start(store);
  seal(store);
  const first = store.goalCodeEvidence(id(1));
  store.reviewGoal(id(1), candidate, true, 100);
  store.claim();
  seal(store, 1, snapshot(repository, "second revision\n"));
  const pending = store.goalCodeEvidence(id(1));
  store.finish(id(1), "interrupted", "Review timed out", "task_timeout", 100);
  store.recover(id(1), thread, id(2));
  assert.equal(store.goal(id(2)).repository_path, repository);
  assert.deepEqual(
    { ...store.goalCodeEvidence(id(2), 1), job_id: id(1) },
    { ...first },
  );
  assert.deepEqual(
    { ...store.goalCodeEvidence(id(2), 2), job_id: id(1) },
    { ...pending },
  );
  assert.equal(store.goalReviews(id(2)).length, 1);
  assert.equal(store.workflow(id(2)).elapsed_ms, 2668);
});

test("fresh same-goal budget retains bound pending candidate but remaps evidence to step one", (t) => {
  const { store } = fixture(t);
  start(store);
  seal(store);
  store.reviewGoal(id(1), candidate, true, 100);
  store.claim();
  seal(store, 1, snapshot(repository, "next revision\n"));
  const pending = store.goalCodeEvidence(id(1));
  store.finish(id(1), "failed", "Uncertain reviewer", "turn_failed", 100);
  store.recover(id(1), thread, id(2), {
    work: { goal: "Fix source", budgetMs: 60000, supervised: true },
  });
  assert.equal(store.goal(id(2)).repository_path, repository);
  assert.equal(store.goal(id(2)).pending_output, JSON.stringify(candidate));
  assert.deepEqual(
    { ...store.goalCodeEvidence(id(2), 1), job_id: id(1), step: 2 },
    { ...pending },
  );
  assert.equal(store.goalCodeEvidence(id(2), 2), undefined);
  assert.equal(store.workflow(id(2)).step_count, 0);
  assert.equal(store.workflow(id(2)).elapsed_ms, 0);
});

for (const change of [
  { goal: "Changed task" },
  { repositoryPath: "/synthetic/other" },
  { repositoryPath: null },
]) {
  test(`fresh changed goal/repository discards candidate and code proof: ${JSON.stringify(change)}`, (t) => {
    const { store } = fixture(t);
    start(store);
    seal(store);
    const old = store.goalCodeEvidence(id(1));
    store.finish(id(1), "failed", "Review uncertain", "turn_failed", 1);
    store.recover(id(1), thread, id(2), {
      work: {
        goal: "Fix source",
        budgetMs: 60000,
        supervised: true,
        ...change,
      },
    });
    assert.equal(store.goal(id(2)).pending_output, null);
    assert.equal(store.goalCodeEvidence(id(2)), undefined);
    assert.deepEqual(store.goalCodeEvidence(id(1)), old);
    assert.equal(
      store.goal(id(2)).repository_path,
      change.repositoryPath === undefined ? repository : change.repositoryPath,
    );
  });
}

test("uncertain worker recovery never silently reuses the original attempt baseline", (t) => {
  const { store } = fixture(t);
  start(store);
  store.saveGoalBaseline(id(1), JSON.stringify(snapshot()));
  const old = store.goalCodeEvidence(id(1));
  store.finish(
    id(1),
    "interrupted",
    "Worker may have changed files",
    "task_timeout",
    100,
  );
  store.recover(id(1), thread, id(2));
  assert.equal(store.goal(id(2)).repository_path, repository);
  assert.equal(store.goalCodeEvidence(id(2)), undefined);
  assert.deepEqual(store.goalCodeEvidence(id(1)), old);
});

test("schema5 migration preserves legacy goal bytes and starts with no fabricated evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plompy-goal-code-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.sqlite");
  const old = schema5(path);
  const store = new Store(path);
  t.after(() => store.close());
  assert.equal(SCHEMA_VERSION, 6);
  assert.deepEqual(
    store.db
      .prepare("SELECT * FROM goals")
      .all()
      .map(({ repository_path, ...row }) => row),
    old,
  );
  assert.equal(store.goal(id(1)).repository_path, null);
  assert.equal(store.goalCodeEvidence(id(1)), undefined);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 6);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("schema6 validates code evidence storage before any journal or file mutation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plompy-goal-code-corrupt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.sqlite");
  const store = new Store(path);
  store.db.exec("DROP TABLE goal_code_evidence; PRAGMA journal_mode=DELETE");
  store.close();
  const original = readFileSync(path);
  assert.throws(() => new Store(path), /code evidence storage is missing/);
  assert.deepEqual(readFileSync(path), original);
});

test("failed5to6 migration rolls repository column, new table and schema version back", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plompy-goal-code-rollback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.sqlite");
  schema5(path);
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE goal_code_evidence(collision TEXT)");
  old.close();
  assert.throws(() => new Store(path), /already exists/);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
  assert.equal(
    db
      .prepare("PRAGMA table_info(goals)")
      .all()
      .some((row) => row.name === "repository_path"),
    false,
  );
});

test("current-schema restart keeps sealed candidate proof and conservatively interrupts execution", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plompy-goal-code-restart-"));
  const path = join(dir, "queue.sqlite");
  const store = new Store(path);
  start(store);
  seal(store);
  const proof = store.goalCodeEvidence(id(1));
  store.close();
  const reopened = new Store(path);
  t.after(() => {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(reopened.recoverStartup(), 1);
  assert.deepEqual(reopened.goalCodeEvidence(id(1)), proof);
  assert.equal(reopened.goal(id(1)).pending_output, JSON.stringify(candidate));
  assert.equal(reopened.workflow(id(1)).elapsed_ms, 120000);
  assert.equal(reopened.claim(), undefined);
});
