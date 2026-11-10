import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir, symlink, unlink, lstat, link, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { initAcceptance, verifyAcceptance } from "./acceptance.mjs";
import { parseGoalCommand } from "../apps/discord-agent/dist/goals.js";

const execute = promisify(execFile);
const publicRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("./acceptance.mjs", import.meta.url));
const fixedGuard = '  if (quantity < 0) throw new RangeError("Quantity must not be negative.");\n';
const fixtureTestEnvironment = () => Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST_")),
);

async function privateRoot(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "szpont-acceptance-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, name = "private task") {
  const root = await privateRoot(t);
  return { root, ...(await initAcceptance(join(root, name))) };
}

async function fix(repository) {
  const source = join(repository, "src/quantity.mjs");
  const original = await readFile(source, "utf8");
  await writeFile(source, original.replace("  const quantity = Number(input.trim());\n", "  const quantity = Number(input.trim());\n" + fixedGuard));
}

async function cliResult(args, options = {}) {
  try {
    const result = await execute(process.execPath, [cli, ...args], { timeout: 10_000, maxBuffer: 64 * 1024, ...options });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("real fixture tests and independent checker go RED to GREEN only after production fix", async (t) => {
  const item = await fixture(t, process.platform === "win32" ? "task with spaces" : 'task with spaces and "quotes"');
  assert.deepEqual(item.baseline, {
    schemaVersion: 1, fixture: "quantity-parser-v1", status: "FAIL", check: "fixture_behavior",
    passed: 22, total: 25, failed: ["negative-one", "negative-trimmed", "negative-leading-zero"],
  });
  await assert.rejects(execute(process.execPath, ["--test", "test/quantity.test.mjs"], { cwd: item.repository, env: fixtureTestEnvironment() }),
    (error) => error.code === 1 && error.stdout.includes("rejects negative quantities"));
  const command = parseGoalCommand(item.goal);
  assert.equal(command.kind, "start");
  assert.equal(command.repositoryPath, item.repository);
  assert.equal(command.budgetMs, 30 * 60_000);
  const manifestBefore = await readFile(item.manifest);
  const testBefore = await readFile(join(item.repository, "test/quantity.test.mjs"));
  const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: item.repository })).stdout.trim();
  assert.equal(JSON.parse(manifestBefore).baselineCommit, head);
  assert.equal((await lstat(join(item.repository, ".git"))).isDirectory(), true);
  await fix(item.repository);
  await execute(process.execPath, ["--test", "test/quantity.test.mjs"], { cwd: item.repository, env: fixtureTestEnvironment() });
  assert.deepEqual(await verifyAcceptance(item.manifest), {
    schemaVersion: 1, fixture: "quantity-parser-v1", status: "PASS", check: "fixture_behavior",
    passed: 25, total: 25, failed: [],
  });
  assert.deepEqual(await readFile(item.manifest), manifestBefore);
  assert.deepEqual(await readFile(join(item.repository, "test/quantity.test.mjs")), testBefore);
});

test("CLI prints an honest RED baseline, JSON-quotes paths, and exits 1 before the fix", async (t) => {
  const root = await privateRoot(t);
  const destination = join(root, process.platform === "win32" ? "CLI with spaces" : "CLI with spaces's $(not-executed)");
  const init = await cliResult(["init", "--destination", destination]);
  assert.equal(init.code, 0);
  assert.match(init.stdout, /Independent baseline: RED as expected/);
  assert.match(init.stdout, /No model or Discord task was run/);
  if (process.platform !== "win32") assert.ok(init.stdout.includes(`spaces'"'"'s $(not-executed)`), "Printed shell command must escape apostrophes and prevent expansion.");
  const goal = init.stdout.split("\n").find((line) => line.startsWith("!goal "));
  assert.equal(parseGoalCommand(goal).repositoryPath, join(destination, "repository"));
  const manifest = join(destination, "acceptance-manifest.json");
  const red = await cliResult(["verify", "--manifest", manifest]);
  assert.equal(red.code, 1);
  assert.equal(JSON.parse(red.stdout).check, "fixture_behavior");
  assert.equal(JSON.parse(red.stdout).passed, 22);
  await fix(join(destination, "repository"));
  const green = await cliResult(["verify", "--manifest", manifest]);
  assert.equal(green.code, 0);
  assert.equal(JSON.parse(green.stdout).status, "PASS");
});

test("container initialization prints an executable host Compose command with literal safe argv", { skip: process.platform === "win32" }, async (t) => {
  const root = await privateRoot(t);
  const destination = join(root, "docker task's $(printf INJECTED) `printf INJECTED`");
  const init = await cliResult(["init", "--destination", destination], {
    env: { ...fixtureTestEnvironment(), SZPONT_CONTAINER_RUNNER: "codex" },
  });
  assert.equal(init.code, 0);
  assert.match(init.stdout, /on the Docker host in a POSIX shell/);
  const command = init.stdout.split("\n").find((line) => line.startsWith("docker compose run "));
  assert.ok(command, "The container must print the host Compose entrypoint command.");
  assert.equal(init.stdout.includes("npm run acceptance -- verify"), false);
  const bin = join(root, "mock-bin");
  await mkdir(bin);
  const docker = join(bin, "docker");
  await writeFile(docker, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(docker, 0o700);
  // The mock has no Docker, account or network access. printf substitutions in
  // the synthetic path would alter argv if the printed command were misquoted.
  const { stdout } = await execute("/bin/sh", ["-c", command], {
    env: { PATH: bin }, timeout: 2000, maxBuffer: 8192,
  });
  assert.deepEqual(JSON.parse(stdout), [
    "compose", "run", "--rm", "engine", "acceptance", "verify", "--manifest",
    join(destination, "acceptance-manifest.json"),
  ]);
  assert.equal(parseGoalCommand(init.stdout.split("\n").find((line) => line.startsWith("!goal "))).repositoryPath,
    join(destination, "repository"));
});

for (const [name, mutate] of [
  ["weakened existing test", async (repo) => writeFile(join(repo, "test/quantity.test.mjs"), 'import test from "node:test"; test("all fine", () => {});\n')],
  ["deleted existing test", async (repo) => unlink(join(repo, "test/quantity.test.mjs"))],
  ["truncated existing test", async (repo) => writeFile(join(repo, "test/quantity.test.mjs"), "")],
  ["weakened specification", async (repo) => writeFile(join(repo, "SPEC.md"), "Negative quantities are now allowed.\n")],
  ["fake-green npm test script", async (repo) => {
    const path = join(repo, "package.json");
    const pkg = JSON.parse(await readFile(path, "utf8"));
    pkg.scripts.test = 'node -e "process.exit(0)"';
    await writeFile(path, JSON.stringify(pkg));
    await execute(process.execPath, ["-e", "process.exit(0)"], { cwd: repo });
  }],
]) {
  test(`independent verification refuses ${name} even with a correct production fix`, async (t) => {
    const item = await fixture(t);
    await fix(item.repository);
    await mutate(item.repository);
    const result = await verifyAcceptance(item.manifest);
    assert.equal(result.status, "FAIL");
    assert.notEqual(result.check, "fixture_behavior");
  });
}

test("changing both a test and its manifest hash cannot redefine the trusted baseline", async (t) => {
  const item = await fixture(t);
  await fix(item.repository);
  await writeFile(join(item.repository, "test/quantity.test.mjs"), "// no tests\n");
  const manifest = JSON.parse(await readFile(item.manifest, "utf8"));
  manifest.files["test/quantity.test.mjs"] = "0".repeat(64);
  await writeFile(item.manifest, JSON.stringify(manifest));
  assert.equal((await verifyAcceptance(item.manifest)).check, "manifest_integrity");
});

test("Git baseline replacement is rejected while ordinary fix commits remain allowed", async (t) => {
  const item = await fixture(t);
  await fix(item.repository);
  await execute("git", ["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-am", "Fix quantities"], { cwd: item.repository });
  assert.equal((await verifyAcceptance(item.manifest)).status, "PASS");
  const manifest = JSON.parse(await readFile(item.manifest, "utf8"));
  manifest.baselineCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: item.repository })).stdout.trim();
  await writeFile(item.manifest, JSON.stringify(manifest));
  assert.equal((await verifyAcceptance(item.manifest)).check, "baseline_integrity");
});

for (const [name, source, expected] of [
  ["a constant-return fake fix", "export const parseQuantity = () => 0;\n", "fixture_behavior"],
  ["a successful exit without checking behavior", "process.exit(0);\n", "candidate_output"],
  ["truncated candidate output", 'process.stdout.write("{"); process.exit(0);\n', "candidate_output"],
  ["fake green output", 'console.log("PASS"); export const parseQuantity = () => 0;\n', "candidate_output"],
  ["excessive output", 'process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000);\n', "candidate_output_limit"],
  ["an endless candidate", "while (true) {}\n", "candidate_timeout"],
]) {
  test(`checker fails closed for ${name}`, async (t) => {
    const item = await fixture(t);
    await writeFile(join(item.repository, "src/quantity.mjs"), source);
    const start = Date.now();
    const result = await verifyAcceptance(item.manifest, { timeoutMs: 400 });
    assert.equal(result.status, "FAIL");
    assert.equal(result.check, expected);
    assert.ok(Date.now() - start < 5000, "Child failure must be bounded.");
  });
}

test("candidate environment excludes credentials, NODE_OPTIONS, and Git overrides; output stays private", async (t) => {
  const item = await fixture(t);
  await fix(item.repository);
  const source = join(item.repository, "src/quantity.mjs");
  await writeFile(source, `if (process.env.ACCEPTANCE_PRIVATE_SECRET || process.env.NODE_OPTIONS || process.env.GIT_DIR) throw new Error("unexpected inherited environment");\n${await readFile(source, "utf8")}`);
  const saved = Object.fromEntries(["ACCEPTANCE_PRIVATE_SECRET", "NODE_OPTIONS", "GIT_DIR"].map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  process.env.ACCEPTANCE_PRIVATE_SECRET = "synthetic-credential-not-for-child";
  process.env.NODE_OPTIONS = "--no-warnings";
  process.env.GIT_DIR = "/synthetic-not-a-repository";
  assert.equal((await verifyAcceptance(item.manifest)).status, "PASS");
  await writeFile(source, 'console.error("synthetic-private-output-must-not-leak"); throw new Error("synthetic-credential-not-for-child");\n');
  const report = JSON.stringify(await verifyAcceptance(item.manifest));
  assert.equal(JSON.parse(report).status, "FAIL");
  assert.equal(report.includes("synthetic-private-output-must-not-leak"), false);
  assert.equal(report.includes("synthetic-credential-not-for-child"), false);
  assert.equal(report.includes(item.repository), false);
});

test("initialization preserves an existing destination and refuses unsafe paths", async (t) => {
  const root = await privateRoot(t);
  const existing = join(root, "existing");
  await mkdir(existing);
  await writeFile(join(existing, "keep"), "unchanged");
  await assert.rejects(initAcceptance(existing), (error) => error.code === "destination_exists");
  assert.equal(await readFile(join(existing, "keep"), "utf8"), "unchanged");
  for (const path of ["relative", `${root}/a/../escape`, `${root}/./escape`, join(root, "bad\nname")])
    await assert.rejects(initAcceptance(path), (error) => error.code === "unsafe_path");
  await assert.rejects(initAcceptance(join(publicRoot, "acceptance-must-not-exist")), (error) => error.code === "public_destination");
  await assert.rejects(initAcceptance(join(root, "missing-parent", "task")));
  await assert.rejects(lstat(join(root, "missing-parent")), { code: "ENOENT" });
});

test("symlink parents, destinations, manifests, and source files are refused", async (t) => {
  const root = await privateRoot(t);
  await mkdir(join(root, "real-parent"));
  const alias = join(root, "alias");
  try { await symlink(join(root, "real-parent"), alias, "junction"); }
  catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") { t.skip("Symlink creation requires Windows permission."); return; }
    throw error;
  }
  await assert.rejects(initAcceptance(join(alias, "new-task")), (error) => error.code === "symlink_path");
  await assert.rejects(initAcceptance(alias), (error) => error.code === "destination_exists");
  const item = await initAcceptance(join(root, "task"));
  await fix(item.repository);
  const candidate = join(item.repository, "src/quantity.mjs");
  const outside = join(root, "outside.mjs");
  await writeFile(outside, await readFile(candidate));
  await unlink(candidate);
  await symlink(outside, candidate, "file");
  assert.equal((await verifyAcceptance(item.manifest)).check, "symlink_path");
  await unlink(candidate);
  await writeFile(candidate, await readFile(outside));
  const movedManifest = join(root, "original-manifest.json");
  await writeFile(movedManifest, await readFile(item.manifest));
  await unlink(item.manifest);
  await symlink(movedManifest, item.manifest, "file");
  assert.equal((await verifyAcceptance(item.manifest)).check, "symlink_path");
});

test("truncated manifests and repository redirection fail closed without leaking file contents", async (t) => {
  const item = await fixture(t);
  const original = JSON.parse(await readFile(item.manifest, "utf8"));
  await writeFile(item.manifest, '{"schemaVersion":');
  assert.equal((await verifyAcceptance(item.manifest)).check, "manifest_format");
  original.repository = join(item.root, "some-other-repository");
  await writeFile(item.manifest, JSON.stringify(original));
  assert.equal((await verifyAcceptance(item.manifest)).check, "manifest_integrity");
  const missing = await cliResult(["verify", "--manifest", join(item.root, "absent", "acceptance-manifest.json")]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).status, "FAIL");
  assert.equal(missing.stdout.includes(item.root), false);
});

test("hard-linked and oversized candidate files are refused before execution", async (t) => {
  const item = await fixture(t);
  const candidate = join(item.repository, "src/quantity.mjs");
  const outside = join(item.root, "outside.mjs");
  await writeFile(outside, await readFile(candidate));
  await unlink(candidate);
  await link(outside, candidate);
  assert.equal((await verifyAcceptance(item.manifest)).check, "unsafe_file");
  await unlink(candidate);
  await writeFile(candidate, "x".repeat(32 * 1024 + 1));
  assert.equal((await verifyAcceptance(item.manifest)).check, "unsafe_file");
});

test("a timed-out candidate's ordinary subprocess is terminated with its POSIX process group", { skip: process.platform === "win32" }, async (t) => {
  const item = await fixture(t);
  await writeFile(join(item.repository, "src/quantity.mjs"), `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(new URL("../child-pid", import.meta.url), String(child.pid));
setInterval(() => {}, 1000);
`);
  assert.equal((await verifyAcceptance(item.manifest, { timeoutMs: 500 })).check, "candidate_timeout");
  const pid = Number(await readFile(join(item.repository, "child-pid"), "utf8"));
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt++) {
    try { process.kill(pid, 0); await new Promise((done) => setTimeout(done, 25)); }
    catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
  }
  assert.equal(alive, false, "A normal inherited process-group child must not remain running.");
});
