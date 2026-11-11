import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
  stat,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportReviewEvidence } from "../dist/review-evidence.js";
const job = "5555000000000001001";
const evidence = {
  version: 1,
  root: "/synthetic/project",
  status: "unavailable",
  beforeHash: null,
  afterHash: null,
  beforeHead: null,
  afterHead: null,
  changes: [],
  patch: "",
  omissions: [],
  note: "Synthetic missing baseline, never a clean verdict",
  error: "baseline_unavailable",
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "plompy-evidence-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("private evidence export is durable, idempotent and never overwrites a different receipt", async (t) => {
  const root = await fixture(t);
  const path = await exportReviewEvidence(root, job, 1, evidence);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), evidence);
  assert.equal(await exportReviewEvidence(root, job, 1, evidence), path);
  await writeFile(path, "changed by another actor");
  await assert.rejects(exportReviewEvidence(root, job, 1, evidence), /differs/);
  assert.equal(await readFile(path, "utf8"), "changed by another actor");
});
test("evidence directories and files cannot redirect writes through symlinks", async (t) => {
  const root = await fixture(t);
  const other = await fixture(t);
  await symlink(other, join(root, "goal-review-evidence"));
  await assert.rejects(exportReviewEvidence(root, job, 1, evidence), /Unsafe/);
  await rm(join(root, "goal-review-evidence"));
  await mkdir(join(root, "goal-review-evidence"), { mode: 0o700 });
  await mkdir(join(root, "goal-review-evidence", job), { mode: 0o700 });
  const victim = join(other, "unchanged");
  await writeFile(victim, "keep");
  await symlink(victim, join(root, "goal-review-evidence", job, "step-1.json"));
  await assert.rejects(exportReviewEvidence(root, job, 1, evidence));
  assert.equal(await readFile(victim, "utf8"), "keep");
});
