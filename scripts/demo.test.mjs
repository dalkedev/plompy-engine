import { test } from "node:test";
import assert from "node:assert/strict";
import { runDemo } from "./demo.mjs";

test("offline demo exercises real continuity, recovery and mixed-provider scheduling without external adapters", async () => {
  const output = [];
  const result = await runDemo("all", (line) => output.push(line));
  assert.deepEqual(result, {
    session: { sameSession: true, separateSession: true, runs: 3 },
    recovery: {
      noReplay: true,
      recovered: true,
      cancelledFollowup: true,
      runs: 2,
    },
    providers: {
      bindingRetained: true,
      otherProviderRan: true,
      openBound: true,
      waitingFinished: true,
      runs: 4,
    },
  });
  const text = output.join("\n");
  assert.match(text, /Offline demo · synthetic data · no model calls/);
  assert.match(text, /transport, readiness and agent replies are scripted/);
  assert.match(text, /Thread: blocked after a failed task/);
  assert.match(text, /#new-claude · queued · Claude Code · session=none/);
  assert.doesNotMatch(
    text,
    /(?:\/Users\/|\/tmp\/|\/var\/folders\/|synthetic-demo-token|90000000-0000-4000-8000-)/,
  );
});

test("offline demo output is reproducible and each scenario is independently runnable", async () => {
  for (const mode of ["session", "recovery", "providers"]) {
    const first = [],
      second = [];
    await runDemo(mode, (line) => first.push(line));
    await runDemo(mode, (line) => second.push(line));
    assert.deepEqual(first, second);
  }
});

test("offline demo rejects unknown modes before creating runtime state", async () => {
  await assert.rejects(
    runDemo("live", () => assert.fail("No output expected.")),
    /Usage:/,
  );
});
