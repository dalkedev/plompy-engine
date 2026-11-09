import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  rename,
  chmod,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureRepository,
  compareRepository,
  validateRepositorySnapshot,
  validateRepositoryDiffEvidence,
  REPOSITORY_FILE_MAX_BYTES,
  REPOSITORY_PATCH_MAX_BYTES,
  REPOSITORY_MAX_FILES,
  REPOSITORY_EVIDENCE_MAX_BYTES,
} from "../dist/repository-diff.js";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}
async function fixture(
  t,
  entries = { "source.ts": "export const value = 1;\n" },
) {
  const directory = await mkdtemp(join(tmpdir(), "szpont-repository-diff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  await mkdir(root);
  git(root, "init", "--quiet");
  for (const [path, content] of Object.entries(entries)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  if (Object.keys(entries).length) {
    git(root, "add", "--all");
    git(
      root,
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "synthetic baseline",
    );
  }
  return { directory, root };
}
const paths = (snapshot) => snapshot.files.map((file) => file.path);

test("actual step diff starts at dirty bytes and survives worker staging and commits", async (t) => {
  const { root, directory } = await fixture(t, {
    "source.ts": "committed baseline\n",
    "delete.ts": "remove me\n",
  });
  await writeFile(join(root, "source.ts"), "pre-existing dirty work\n");
  const status = git(root, "status", "--porcelain");
  const before = await captureRepository(root);
  assert.equal(
    git(root, "status", "--porcelain"),
    status,
    "capture must preserve index/working state",
  );
  await writeFile(join(root, "source.ts"), "requested step change\n");
  await rm(join(root, "delete.ts"));
  git(root, "add", "--all");
  git(
    root,
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "worker commit",
  );
  await writeFile(join(root, "new.test.ts"), "assert(value === 2);\n");
  const workerStatus = git(root, "status", "--porcelain"),
    workerHead = git(root, "rev-parse", "HEAD");
  const after = await captureRepository(root, { previousPaths: paths(before) });
  const evidence = await compareRepository(before, after, {
    temporaryDirectory: directory,
  });
  assert.equal(evidence.status, "complete");
  assert.notEqual(evidence.beforeHead, evidence.afterHead);
  assert.match(
    evidence.patch,
    /-pre-existing dirty work\n\+requested step change/,
  );
  assert.doesNotMatch(evidence.patch, /-committed baseline/);
  assert.deepEqual(
    evidence.changes.map(({ path, kind }) => [path, kind]),
    [
      ["delete.ts", "deleted"],
      ["new.test.ts", "added"],
      ["source.ts", "modified"],
    ],
  );
  assert.equal(git(root, "status", "--porcelain"), workerStatus);
  assert.equal(git(root, "rev-parse", "HEAD"), workerHead);
  assert.doesNotMatch(evidence.patch, /szpont-repository-diff-/);
  assert.match(evidence.note, /not proof of authorship/);
});

test("new ignore rules cannot hide a previously observed untracked source; secret contents are omitted", async (t) => {
  const { root } = await fixture(t, {
    ".gitignore": ".env\nignored.txt\n",
    "source.ts": "baseline\n",
  });
  await writeFile(join(root, ".env"), "DO_NOT_CAPTURE_OWNER_SECRET\n");
  git(root, "add", "--force", ".env");
  await writeFile(join(root, "ignored.txt"), "IGNORED_PRIVATE_VALUE\n");
  await writeFile(join(root, "draft.ts"), "before\n");
  const before = await captureRepository(root);
  assert.equal(
    before.files.find((f) => f.path === ".env").reason,
    "sensitive_path",
  );
  assert(!paths(before).includes("ignored.txt"));
  await writeFile(join(root, ".gitignore"), ".env\nignored.txt\ndraft.ts\n");
  await writeFile(join(root, "draft.ts"), "after\n");
  const after = await captureRepository(root, { previousPaths: paths(before) });
  const evidence = await compareRepository(before, after);
  assert.equal(evidence.status, "partial");
  assert(evidence.changes.some((change) => change.path === "draft.ts"));
  assert.match(evidence.patch, /-before\n\+after/);
  assert.doesNotMatch(
    JSON.stringify([before, after, evidence]),
    /DO_NOT_CAPTURE_OWNER_SECRET|IGNORED_PRIVATE_VALUE/,
  );
});

test("symlink contents and injected symlink parents never escape the explicit root", async (t) => {
  const { root, directory } = await fixture(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "NEVER_READ_SYMLINK_TARGET\n");
  await symlink(outside, join(root, "link"));
  await link(join(outside, "secret.txt"), join(root, "hard-linked.ts"));
  const snapshot = await captureRepository(root, {
    previousPaths: ["link/secret.txt"],
  });
  assert.equal(snapshot.files.find((f) => f.path === "link").kind, "symlink");
  assert.equal(
    snapshot.files.find((f) => f.path === "link/secret.txt").reason,
    "unsafe_path",
  );
  assert.equal(
    snapshot.files.find((file) => file.path === "hard-linked.ts").reason,
    "unsafe_path",
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /NEVER_READ_SYMLINK_TARGET/);
  assert.equal(snapshot.complete, false);
  await assert.rejects(
    captureRepository(root, { previousPaths: ["../outside/secret.txt"] }),
    /repository_previous_path_invalid/,
  );
});

test("binary, oversized, executable-mode and rename-like changes remain visible without pretending full text coverage", async (t) => {
  const { root } = await fixture(t, {
    "old.ts": "rename content\n",
    "mode.ts": "same bytes\n",
    "binary.bin": Buffer.from([0, 1, 2]),
    "large.txt": "x".repeat(REPOSITORY_FILE_MAX_BYTES + 1),
  });
  const before = await captureRepository(root);
  await rename(join(root, "old.ts"), join(root, "renamed.ts"));
  await chmod(join(root, "mode.ts"), 0o755);
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 4, 5]));
  const after = await captureRepository(root, { previousPaths: paths(before) });
  const evidence = await compareRepository(before, after);
  assert.equal(evidence.status, "partial");
  assert(evidence.omissions.some((v) => v.reason === "binary"));
  assert(evidence.omissions.some((v) => v.reason === "file_size"));
  assert(
    evidence.changes.some(
      (v) => v.path === "binary.bin" && v.kind === "modified",
    ),
  );
  assert(
    evidence.changes.some(
      (v) => v.path === "mode.ts" && v.kind === "mode_changed",
    ),
  );
  assert(
    evidence.changes.some((v) => v.path === "old.ts" && v.kind === "deleted"),
  );
  assert(
    evidence.changes.some((v) => v.path === "renamed.ts" && v.kind === "added"),
  );
});

test("Git filters, external diff and fsmonitor are not executed; hunk text resembling headers stays intact", async (t) => {
  const { root, directory } = await fixture(t, {
    "source.txt": "-- removed content\n",
    ".gitattributes": "*.txt filter=synthetic diff=synthetic\n",
  });
  const sentinel = join(directory, "should-not-exist");
  const command = `touch ${JSON.stringify(sentinel)}`;
  git(root, "config", "filter.synthetic.clean", command);
  git(root, "config", "diff.synthetic.command", command);
  git(root, "config", "core.fsmonitor", command);
  const before = await captureRepository(root);
  await writeFile(join(root, "source.txt"), "++ added content\n");
  const after = await captureRepository(root);
  const evidence = await compareRepository(before, after);
  await assert.rejects(access(sentinel));
  assert.match(evidence.patch, /--- removed content\n\+\+\+ added content/);
  await assert.rejects(
    compareRepository(before, after, { temporaryDirectory: root }),
    /repository_scratch_inside_root/,
  );
});

test("file-count and patch/output limits are explicit and all serialized evidence stays bounded", async (t) => {
  const { root } = await fixture(t, {});
  for (let i = 0; i < REPOSITORY_MAX_FILES + 2; i += 32)
    await Promise.all(
      Array.from(
        { length: Math.min(32, REPOSITORY_MAX_FILES + 2 - i) },
        (_, j) =>
          writeFile(
            join(root, `f${String(i + j).padStart(5, "0")}.txt`),
            "a\n",
          ),
      ),
    );
  const limited = await captureRepository(root);
  assert.equal(limited.complete, false);
  assert.equal(limited.files.length, REPOSITORY_MAX_FILES);
  assert(limited.omissions.some((v) => v.reason.startsWith("file_limit:")));
  const second = await fixture(t, {
    "huge.ts": "x".repeat(REPOSITORY_FILE_MAX_BYTES),
  });
  const before = await captureRepository(second.root);
  await writeFile(
    join(second.root, "huge.ts"),
    "y".repeat(REPOSITORY_FILE_MAX_BYTES),
  );
  const after = await captureRepository(second.root);
  const evidence = await compareRepository(before, after);
  assert.equal(evidence.status, "partial");
  assert(evidence.omissions.some((v) => v.reason === "patch_limit"));
  assert(Buffer.byteLength(evidence.patch) <= REPOSITORY_PATCH_MAX_BYTES);
  assert(
    Buffer.byteLength(JSON.stringify(evidence)) <=
      REPOSITORY_EVIDENCE_MAX_BYTES,
  );
});

test("unborn repositories work, snapshots reject tampering, unavailable evidence is distinct, cancellation does not mutate source", async (t) => {
  const { root } = await fixture(t, {});
  await writeFile(join(root, "initial.ts"), "initial\n");
  const before = await captureRepository(root);
  assert.equal(before.head, null);
  assert.equal(before.complete, true);
  const tampered = structuredClone(before);
  tampered.files[0].text = "forged\n";
  assert.throws(
    () => validateRepositorySnapshot(tampered),
    /repository_evidence_invalid/,
  );
  const unavailable = {
    version: 1,
    root,
    status: "unavailable",
    beforeHash: before.contentHash,
    afterHash: null,
    beforeHead: null,
    afterHead: null,
    changes: [],
    patch: "",
    omissions: [],
    note: "Capture failed; this is not an empty diff",
    error: "repository_capture_failed",
  };
  assert.equal(
    validateRepositoryDiffEvidence(unavailable).status,
    "unavailable",
  );
  assert.throws(
    () =>
      validateRepositoryDiffEvidence({ ...unavailable, status: "complete" }),
    /repository_evidence_invalid/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    captureRepository(root, { signal: abort.signal }),
    /repository_capture_cancelled/,
  );
  assert.equal(await readFile(join(root, "initial.ts"), "utf8"), "initial\n");
  await mkdir(join(root, "nested"));
  await assert.rejects(
    captureRepository(join(root, "nested")),
    /repository_root_not_toplevel/,
  );
});

test("encoded unusual paths and actual mode/content changes form a real reversible Git patch", async (t) => {
  const filename = 'odd\nquote"\\name.ts';
  const { root } = await fixture(t, { [filename]: "before\n" });
  const before = await captureRepository(root);
  await writeFile(join(root, filename), "after\n");
  await chmod(join(root, filename), 0o755);
  const after = await captureRepository(root);
  const evidence = await compareRepository(before, after);
  assert.equal(evidence.status, "complete");
  assert.match(evidence.patch, /old mode 100644\nnew mode 100755/);
  assert.match(evidence.patch, /\\012/);
  assert.doesNotMatch(evidence.patch, /szpont-diff-/);
  execFileSync("git", ["-C", root, "apply", "--check", "--reverse", "-"], {
    input: evidence.patch,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(await readFile(join(root, filename), "utf8"), "after\n");
});

test(
  "raw invalid UTF-8 Git filenames cannot alias valid replacement-character paths",
  {
    skip:
      process.platform !== "linux" &&
      "POSIX raw-byte filename case runs on Linux CI",
  },
  async (t) => {
    const { root } = await fixture(t);
    const invalid = Buffer.concat([
      Buffer.from(root + "/bad-"),
      Buffer.from([255]),
      Buffer.from(".txt"),
    ]);
    await writeFile(invalid, "invalid-byte name\n");
    await writeFile(join(root, "bad-\uFFFD.txt"), "MUST_NOT_ALIAS_THIS_FILE\n");
    await assert.rejects(captureRepository(root), /repository_output_encoding/);
  },
);

test("committed deletion tombstones do not create false drift at the next fresh baseline", async (t) => {
  const { root } = await fixture(t, {
    "keep.ts": "keep\n",
    "delete.ts": "delete\n",
  });
  const before = await captureRepository(root);
  await rm(join(root, "delete.ts"));
  git(root, "add", "--all");
  git(
    root,
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "delete in worker step",
  );
  const after = await captureRepository(root, { previousPaths: paths(before) });
  assert.equal(
    after.files.find((file) => file.path === "delete.ts").kind,
    "missing",
  );
  const fresh = await captureRepository(root);
  assert(!fresh.files.some((file) => file.path === "delete.ts"));
  assert.equal(after.contentHash, fresh.contentHash);
  const deletion = await compareRepository(before, after);
  assert(
    deletion.changes.some(
      (file) => file.path === "delete.ts" && file.kind === "deleted",
    ),
  );
  const noDrift = await compareRepository(after, fresh);
  assert.deepEqual(noDrift.changes, []);
  assert.equal(noDrift.status, "complete");
});

test("a swapped bound root is rejected before Git or outside-repository reads", async (t) => {
  const original = await fixture(t);
  const outside = await fixture(t, { "outside.ts": "OUTSIDE_BOUND_SCOPE\n" });
  const before = await captureRepository(original.root);
  const alias = join(original.directory, "alias");
  await symlink(original.root, alias);
  assert.equal(
    (await captureRepository(alias, { expectedRoot: before.root })).root,
    before.root,
    "normal aliases can resolve to the existing canonical binding",
  );
  await rename(original.root, original.root + "-moved");
  await symlink(outside.root, original.root);
  const counter = join(original.directory, "git-was-invoked");
  const bin = join(original.directory, "bin");
  await mkdir(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}\nconst fs=require('node:fs');const {spawnSync}=require('node:child_process');fs.appendFileSync(${JSON.stringify(counter)},'called\\n');const result=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);\n`,
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = bin + ":" + previousPath;
    await assert.rejects(
      captureRepository(original.root, {
        expectedRoot: before.root,
        previousPaths: paths(before),
      }),
      /repository_root_changed/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  await assert.rejects(
    access(counter),
    "root binding must be checked before invoking Git on the replacement",
  );
  assert.equal(
    await readFile(join(outside.root, "outside.ts"), "utf8"),
    "OUTSIDE_BOUND_SCOPE\n",
  );
});
