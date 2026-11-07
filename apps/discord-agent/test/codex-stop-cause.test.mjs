import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodex } from "../dist/codex.js";

const session = "01a12345-1234-7456-8456-123456789abc";
async function fixture(t, failureType, timeoutMs) {
  const root = await mkdtemp(join(tmpdir(), "szpont-stop-cause-"));
  for (const name of ["workspace", "state", "artifacts", "codex", "browser"])
    await mkdir(join(root, name));
  const path = join(root, "fake-codex.mjs");
  await writeFile(
    path,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(join(root, "state/stopped"))}, "graceful shutdown");
  process.stdout.write(JSON.stringify({type: ${JSON.stringify(failureType)}, error: {code: "synthetic_shutdown"}}) + "\\n", () => process.exit(0));
});
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({type: "thread.started", thread_id: ${JSON.stringify(session)}}));
  setInterval(() => {}, 1000);
});
`,
  );
  await chmod(path, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    token: "synthetic-secret",
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    codexHome: join(root, "codex"),
    browserDir: join(root, "browser"),
    codexBin: path,
    timeoutMs,
  };
}

for (const event of ["turn.failed", "error"]) {
  test(`graceful ${event} after timeout preserves the timeout cause`, async (t) => {
    const config = await fixture(t, event, 5000);
    const result = await runCodex(config, "Synthetic prompt", null, () => {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "task_timeout");
    assert.equal(result.sessionId, session);
    assert.equal(result.output, "");
    assert.equal(
      await readFile(join(config.stateDir, "stopped"), "utf8"),
      "graceful shutdown",
    );
  });

  test(`graceful ${event} after owner cancellation preserves the cancellation cause`, async (t) => {
    const config = await fixture(t, event, 10_000);
    const controller = new AbortController();
    const result = await runCodex(
      config,
      "Synthetic prompt",
      null,
      () => controller.abort(),
      controller.signal,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "owner_or_service_cancelled");
    assert.equal(result.sessionId, session);
    assert.equal(result.output, "");
    assert.equal(
      await readFile(join(config.stateDir, "stopped"), "utf8"),
      "graceful shutdown",
    );
  });
}
