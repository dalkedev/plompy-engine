// Real installed CLI/filesystem acceptance. No Discord network, model, or credentials.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const source = fileURLToPath(new URL("../", import.meta.url));
const secret = "synthetic-installation-token-not-a-real-discord-credential";
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "PLOMPY_CONTAINER_RUNNER"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const hash = (data) => createHash("sha256").update(data).digest("hex");
let temporary;

async function run(binary, args, label) {
  try {
    const result = await execute(binary, args, {
      cwd: source,
      env,
      timeout: 25_000,
      maxBuffer: 131_072,
    });
    assert(
      !result.stdout.includes(secret) && !result.stderr.includes(secret),
      "Synthetic credential escaped into CLI output",
    );
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    if (typeof error.code !== "number" || error.killed)
      throw new Error(`${label}: process could not complete within bounds`);
    assert(
      !String(error.stdout).includes(secret) &&
        !String(error.stderr).includes(secret),
      "Synthetic credential escaped into CLI output",
    );
    return { code: error.code, stdout: String(error.stdout ?? "") };
  }
}
const cli = (name, args, label) =>
  run(
    process.execPath,
    [join(source, "scripts", `${name}.mjs`), ...args],
    label,
  );

try {
  temporary = await realpath(
    await mkdtemp(join(tmpdir(), "plompy-installation-")),
  );
  await chmod(temporary, 0o700);
  const root = join(temporary, "private installation");
  const token = join(temporary, "token");
  await writeFile(token, secret + "\n", { mode: 0o600 });
  const args = [
    "--root",
    root,
    "--runner",
    "codex",
    "--owner-id",
    "222222222222222222",
    "--bot-id",
    "333333333333333333",
    "--guild-id",
    "111111111111111111",
    "--forum-id",
    "444444444444444444",
    "--token-file",
    token,
    "--yes",
  ];
  assert.equal(
    (await cli("setup", args, "setup")).code,
    0,
    "Fresh setup failed",
  );
  const config = join(root, "agent.env");
  const before = hash(await readFile(config));
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  const report = await run(
    "/bin/sh",
    [
      "-c",
      'set -a; . "$1"; set +a; exec "$2" "$3" --json',
      "installation-smoke",
      config,
      process.execPath,
      join(source, "scripts/doctor.mjs"),
    ],
    "doctor",
  );
  const diagnostic = JSON.parse(report.stdout);
  assert.equal(
    report.code,
    0,
    "Installed configuration failed offline doctor: " +
      diagnostic.checks
        .filter((check) => check.status === "FAIL")
        .map((check) => check.id)
        .join(", "),
  );
  assert(
    diagnostic.checks.some(
      (check) => check.id === "codex_version" && check.status === "PASS",
    ),
    "Real pinned Codex CLI version was not verified",
  );
  assert(
    diagnostic.checks
      .filter((check) => check.id.startsWith("discord_"))
      .every((check) => check.status === "NOT_RUN"),
    "Offline smoke unexpectedly inspected Discord",
  );
  assert.notEqual(
    (await cli("setup", args, "repeat setup")).code,
    0,
    "Setup replaced an existing deployment",
  );
  assert.equal(
    hash(await readFile(config)),
    before,
    "Repeat setup changed private configuration",
  );

  const acceptance = join(root, "artifacts", "first code goal");
  assert.equal(
    (
      await cli(
        "acceptance",
        ["init", "--destination", acceptance],
        "acceptance init",
      )
    ).code,
    0,
  );
  const manifest = join(acceptance, "acceptance-manifest.json");
  const verify = () =>
    cli("acceptance", ["verify", "--manifest", manifest], "acceptance verify");
  let result = await verify();
  let receipt = JSON.parse(result.stdout);
  assert.equal(result.code, 1);
  assert.equal(receipt.check, "fixture_behavior");
  assert.equal(receipt.status, "FAIL");
  assert.deepEqual(receipt.failed, [
    "negative-one",
    "negative-trimmed",
    "negative-leading-zero",
  ]);
  const implementation = join(acceptance, "repository/src/quantity.mjs");
  const content = await readFile(implementation, "utf8");
  const marker =
    "  // The fixture deliberately omits negative validation. Follow SPEC.md.";
  assert(content.includes(marker));
  await writeFile(
    implementation,
    content.replace(
      marker,
      '  if (quantity < 0) throw new RangeError("Quantity must not be negative.");',
    ),
  );
  result = await verify();
  receipt = JSON.parse(result.stdout);
  assert.equal(result.code, 0);
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.passed, 25);
  assert.equal(receipt.total, 25);

  await writeFile(
    join(acceptance, "repository/test/quantity.test.mjs"),
    'import test from "node:test"; test("dishonest green", () => {});\n',
  );
  result = await verify();
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).check, "fixture_integrity");
  console.log(
    "PASS real setup, private configuration, actual Codex version and offline doctor",
  );
  console.log(
    "PASS repeated setup preserves deployment; independent fixture RED/GREEN and test-tampering control",
  );
  console.log(
    "NOT RUN Discord permissions/delivery, account login, model execution, live goal review and multi-day operation",
  );
} catch (error) {
  console.error("Installation smoke failed: " + error.message);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
