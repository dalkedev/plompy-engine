import assert from "node:assert/strict";
import { test } from "node:test";
import { failureCategory, safeFailure } from "./smoke.mjs";

test("synthetic smoke diagnostics distinguish sandbox, libraries and startup failures", () => {
  assert.equal(
    failureCategory(
      "browserType.launch: No usable sandbox! AppArmor userns denied",
    ),
    "host-sandbox-unavailable",
  );
  assert.equal(
    failureCategory("Failed to move to new namespace: Operation not permitted"),
    "host-sandbox-unavailable",
  );
  assert.equal(
    failureCategory("error while loading shared libraries: libExample.so"),
    "host-libraries-missing",
  );
  assert.equal(
    failureCategory("Executable doesn't exist at private/path"),
    "browser-or-path-missing",
  );
  assert.equal(
    failureCategory("Socket directory path is too long"),
    "socket-path-too-long",
  );
  assert.equal(
    failureCategory("MCP error -32000: Connection closed"),
    "mcp-startup-closed",
  );
});

test("diagnostics never emit raw page, paths, environment or child output", () => {
  const secret = "SYNTHETIC-PRIVATE-DIAGNOSTIC-CANARY";
  const result = safeFailure(
    "browser-navigate",
    new Error(`No usable sandbox! ${secret}`),
    `/private/${secret} token=${secret}`,
  );
  assert.equal(result.category, "host-sandbox-unavailable");
  assert.equal(result.stage, "browser-navigate");
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(
    failureCategory("x".repeat(65_536) + "No usable sandbox!"),
    "unexpected-acceptance-failure",
  );
});
