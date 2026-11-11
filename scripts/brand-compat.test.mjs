import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeEnvironment, compatiblePath } from "./brand-compat.mjs";
import { normalizeEnvironment as engineNormalize } from "../apps/discord-agent/dist/brand-compat.js";

test("standalone CLIs and compiled engine agree on legacy environment precedence", () => {
  const env = { SZPONT_RUNNER: "claude", SZPONT_STATE_DIR: "/private/old/state", PLOMPY_STATE_DIR: "/private/old/state", SZPONT_BROWSER_DIR: "/private/old/profile", PLOMPY_BROWSER_DIR: "", DISCORD_BOT_TOKEN: "synthetic" };
  const expected = { ...env, PLOMPY_RUNNER: "claude" };
  assert.deepEqual(normalizeEnvironment(env), expected);
  assert.deepEqual(engineNormalize(env), expected);
  assert.equal(env.PLOMPY_RUNNER, undefined);
});

test("legacy private files are selected in place and ambiguous paths require an explicit choice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plompy-path-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current"), legacy = join(root, "legacy");
  assert.equal(compatiblePath(current, legacy), current);
  await writeFile(legacy, "synthetic persistent state");
  assert.equal(compatiblePath(current, legacy), legacy);
  await writeFile(current, "different synthetic state");
  assert.throws(() => compatiblePath(current, legacy), /Both current and legacy/);
});
