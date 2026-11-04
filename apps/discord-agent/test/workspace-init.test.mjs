import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  mkdir,
  writeFile,
  access,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repo, "scripts/init-workspace.mjs");
test("workspace initialization creates private Git memory outside the public checkout", async () => {
  const temp = await mkdtemp(join(tmpdir(), "szpont-init-"));
  const target = join(temp, "private-workspace");
  await exec(process.execPath, [script, target]);
  const user = await readFile(join(target, "agent/USER.md"), "utf8");
  assert.match(user, /Configure/);
  const { stdout } = await exec("git", ["status", "--porcelain"], {
    cwd: target,
  });
  assert.equal(stdout, "");
  const { stdout: tracked } = await exec("git", ["ls-files"], { cwd: target });
  assert.match(tracked, /agent\/POLICY.md/);
  const { stdout: mode } = await exec("stat", ["-c", "%a", target]);
  assert.equal(mode.trim(), "700");
});
test("workspace initialization refuses to overwrite existing owner memory", async () => {
  const temp = await mkdtemp(join(tmpdir(), "szpont-init-"));
  const target = join(temp, "existing");
  await mkdir(target);
  await writeFile(join(target, "keep.txt"), "owner data");
  await assert.rejects(exec(process.execPath, [script, target]));
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "owner data");
  await assert.rejects(access(join(target, "agent")));
});
test("workspace initialization refuses public checkout descendants and symlink aliases", async () => {
  const target = join(repo, "must-not-create-private-state");
  await assert.rejects(exec(process.execPath, [script, target]));
  await assert.rejects(access(target));
  const temp = await mkdtemp(join(tmpdir(), "szpont-init-"));
  await symlink(repo, join(temp, "alias"));
  await assert.rejects(
    exec(process.execPath, [
      script,
      join(temp, "alias", "must-not-create-private-state"),
    ]),
  );
  await assert.rejects(access(target));
});
test("workspace rejection through a symlink never creates intermediate source directories", async () => {
  const temp = await mkdtemp(join(tmpdir(), "szpont-init-"));
  await symlink(repo, join(temp, "alias"));
  const forbiddenParent = join(repo, "must-not-create-parent");
  await assert.rejects(
    exec(process.execPath, [
      script,
      join(temp, "alias", "must-not-create-parent", "workspace"),
    ]),
  );
  await assert.rejects(access(forbiddenParent));
});
