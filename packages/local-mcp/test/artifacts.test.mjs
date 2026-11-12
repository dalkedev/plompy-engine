import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, readFile, readdir, realpath, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportArtifact, readArtifact, listArtifacts } from "../src/artifacts.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "plompy-artifact-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("exports CSV with formula-safe headers, cells, quotes and source fields", async (t) => {
  const root = await fixture(t);
  const report = await exportArtifact(root, { name: "companies.csv", format: "csv", records: [
    { company_name: '=HYPERLINK("https://invalid.example")', public_email: "hello@example.invalid", source_url: "https://example.invalid/contact", draft_body: 'Hi, "team"\nUniversity project', "@formula": " \t+SUM(1,2)" },
    { company_name: "Normal", public_email: null, source_url: "https://example.invalid", draft_body: "-1+1", "@formula": "\tnew cell" },
  ] });
  assert.equal(report.reused, false);
  assert.match(report.sha256, /^[a-f0-9]{64}$/);
  const { content } = await readArtifact(root, { name: "companies.csv" });
  assert.match(content, /"'@formula"/);
  assert.match(content, /"'=HYPERLINK\(""https:\/\/invalid.example""\)"/);
  assert.match(content, /"' \t\+SUM\(1,2\)"/);
  assert.match(content, /"'-1\+1"/);
  assert.match(content, /"'\tnew cell"/);
  assert.match(content, /Hi, ""team""\nUniversity project/);
});

test("identical retry is reused and conflicting name or key never overwrites", async (t) => {
  const root = await fixture(t);
  const specification = { name: "drafts.json", format: "json", records: [{ company: "Fixture only" }], idempotencyKey: "task-one-123" };
  const first = await exportArtifact(root, specification);
  const second = await exportArtifact(root, specification);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.sha256, first.sha256);
  await assert.rejects(exportArtifact(root, { ...specification, records: [{ company: "Different" }] }), /different content/);
  await assert.rejects(exportArtifact(root, { ...specification, name: "another.json" }), /different content/);
  assert.equal((await listArtifacts(root)).length, 1);
  assert.equal((await listArtifacts(root))[0].name, "drafts.json");
  assert.equal((await readArtifact(root, { name: "drafts.json" })).content, '[\n  {\n    "company": "Fixture only"\n  }\n]\n');
});

test("concurrent identical retries create one artifact and report reused results", async (t) => {
  const root = await fixture(t);
  const input = { name: "retry.md", format: "markdown", content: "One result only", idempotencyKey: "concurrent-001" };
  const results = await Promise.all(Array.from({ length: 8 }, () => exportArtifact(root, input)));
  assert.equal(results.filter((entry) => !entry.reused).length, 1);
  assert.equal((await listArtifacts(root)).length, 1);
});

test("rejects traversal, hidden paths, suffix mismatch and unsupported values", async (t) => {
  const root = await fixture(t);
  for (const name of ["../outside.md", "/absolute.md", ".private.md", "nested/file.md", "double..md"])
    await assert.rejects(exportArtifact(root, { name, format: "markdown", content: "test" }), /flat artifact/);
  await assert.rejects(exportArtifact(root, { name: "data.json", format: "csv", records: [] }), /must end/);
  await assert.rejects(exportArtifact(root, { name: "data.csv", format: "csv", records: [{ data: { object: true } }] }), /scalar|cells/);
  await assert.rejects(exportArtifact(root, { name: "data.json", format: "json", records: [{ number: Infinity }] }), /cells/);
  await assert.rejects(exportArtifact(root, { name: "data.md", format: "markdown", content: "a".repeat(1_048_577) }), /1 MiB/);
  await assert.rejects(exportArtifact(root, { name: "data.json", format: "json", records: Array.from({ length: 1001 }, () => ({})) }), /1000/);
  assert.deepEqual(await readdir(root), []);
});

test("rejects symlink root, symlink ancestry and linked or nonprivate destination", async (t) => {
  const root = await fixture(t), outside = await fixture(t);
  await symlink(outside, join(root, "alias"));
  await assert.rejects(exportArtifact(join(root, "alias"), { name: "x.md", format: "markdown", content: "test" }), /symlink/);
  await assert.rejects(exportArtifact(join(root, "alias", "child"), { name: "x.md", format: "markdown", content: "test" }), /symlink/);
  await writeFile(join(outside, "safe.md"), "untouched", { mode: 0o600 });
  await symlink(join(outside, "safe.md"), join(root, "link.md"));
  await assert.rejects(exportArtifact(root, { name: "link.md", format: "markdown", content: "replaced" }), /regular/);
  await assert.rejects(readArtifact(root, { name: "link.md" }), /regular/);
  await link(join(outside, "safe.md"), join(root, "hard.md"));
  await assert.rejects(readArtifact(root, { name: "hard.md" }), /single-link/);
  assert.equal(await readFile(join(outside, "safe.md"), "utf8"), "untouched");
  await mkdir(join(root, "public"), { mode: 0o755 });
  await chmod(join(root, "public"), 0o755);
  await assert.rejects(exportArtifact(join(root, "public"), { name: "x.md", format: "markdown", content: "test" }), /0700/);
});
