import { test } from "node:test";
import assert from "node:assert/strict";
import * as protocol from "../dist/goals.js";

test("goal and loop aliases create bounded fixed goals without parsing embedded commands", () => {
  assert.equal(typeof protocol.parseGoalCommand, "function");
  assert.deepEqual(protocol.parseGoalCommand("!goal Build a useful CLI"), {
    kind: "start",
    goal: "Build a useful CLI",
    budgetMs: 1800000,
  });
  assert.deepEqual(protocol.parseGoalCommand("!loop 2h Fix the queue\n!stop"), {
    kind: "start",
    goal: "Fix the queue\n!stop",
    budgetMs: 7200000,
  });
  assert.deepEqual(
    protocol.parseGoalCommand("!goal pause 5555000000000001001"),
    { kind: "pause", id: "5555000000000001001" },
  );
  assert.deepEqual(protocol.parseGoalCommand("!loop status"), {
    kind: "status",
  });
  assert.equal(protocol.parseGoalCommand("Please use !loop later"), null);
});
test("malformed controls and out-of-range budgets cannot become new goals", () => {
  for (const text of [
    "!goal",
    "!loop 0m nope",
    "!goal 121m nope",
    "!loop 3h nope",
    "!goal pause extra",
    "!goal status 12",
    "!goal resume 5555000000000001001 extra",
    "!goal 30m",
  ])
    assert.throws(() => protocol.parseGoalCommand(text), /goal|loop|Usage/i);
});
test("supervisor review is strict and cannot grant a budget through extra keys", () => {
  const value = {
    outcome: "blocked",
    summary: "Need a decision",
    nextAction: "Which repository is in scope?",
    progress: false,
  };
  assert.deepEqual(protocol.validateGoalReview(JSON.stringify(value)), value);
  for (const bad of [
    { ...value, budgetMs: 7200000 },
    { ...value, progress: "yes" },
    { ...value, outcome: "continue", nextAction: "" },
    { ...value, summary: "x".repeat(4001) },
  ])
    assert.throws(() => protocol.validateGoalReview(JSON.stringify(bad)));
  assert.throws(() => protocol.validateGoalReview("```json\n{}\n```"));
});
test("supervisor prompt labels candidate data, fixes scope and prohibits effects", () => {
  const prompt = protocol.goalReviewPrompt({
    goal: "Synthetic original goal",
    candidate: {
      outcome: "completed",
      summary: "Tests pass at commit abc",
      nextAction: "",
    },
    lastSummary: null,
    nextAction: null,
    step: 1,
    remainingMs: 1000,
  });
  assert.match(prompt, /Synthetic original goal/);
  assert.match(prompt, /untrusted|historical/i);
  assert.match(prompt, /Do not.*(?:write|publish)/i);
  assert.match(prompt, /evidence/i);
});

test("explicit repository bindings parse without changing goal text or interpreting shell syntax", () => {
  assert.deepEqual(
    protocol.parseGoalCommand(
      '!loop 2h --repo "/srv/project with spaces" -- Fix assertions',
    ),
    {
      kind: "start",
      goal: "Fix assertions",
      budgetMs: 7200000,
      repositoryPath: "/srv/project with spaces",
    },
  );
  assert.equal(
    protocol.parseGoalCommand(
      "!goal --repo=/srv/project Read $(whoami) literally",
    ).goal,
    "Read $(whoami) literally",
  );
  assert.equal(
    protocol.parseGoalCommand("!goal 30m --no-repo Review the design")
      .repositoryPath,
    null,
  );
  for (const text of [
    "!goal --repo relative Fix",
    "!goal --repo /srv/project",
    '!goal --repo "/srv/project"suffix Fix',
    '!goal --repo "/srv/escaped\\nname" Fix',
    "!goal --no-repo",
    "!goal --repo /srv/a --repo /srv/b Fix",
  ])
    assert.throws(() => protocol.parseGoalCommand(text));
});

test("large code inventories keep the evidence read path and bounded recent receipts visible", () => {
  const evidence = {
    version: 1,
    root: "/synthetic/repo",
    status: "partial",
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
    beforeHead: null,
    afterHead: null,
    patch: "x".repeat(96000),
    omissions: [{ path: "*", reason: "patch_limit" }],
    note: "Explicit bounded capture",
    changes: Array.from({ length: 100 }, (_, i) => ({
      path: String(i).padStart(3, "0") + "x".repeat(900),
      kind: "added",
      before: null,
      after: { kind: "text", size: 1, mode: 33188, sha256: "c".repeat(64) },
    })),
  };
  const path =
    "/private/synthetic/state/goal-review-evidence/5555000000000001001/step-3.json";
  const prompt = protocol.goalReviewPrompt({
    goal: "Review synthetic code",
    candidate: { outcome: "completed", summary: "Candidate", nextAction: "" },
    lastSummary: null,
    nextAction: null,
    step: 3,
    remainingMs: 60000,
    codeDiff: { evidence, evidencePath: path },
    history: [
      { step: 1, candidate: "oldest-marker", review: "oldest-review" },
      { step: 2, candidate: "recent-candidate", review: "recent-review" },
      { step: 3, candidate: "latest-candidate", review: "latest-review" },
    ],
  });
  assert(Buffer.byteLength(prompt) <= 65536);
  assert(prompt.includes(path));
  assert.match(prompt, /latest-review/);
  assert.doesNotMatch(prompt, /oldest-marker/);
  assert.match(prompt, /further bytes omitted/);
  assert.match(prompt, /Partial or unavailable evidence is never a clean/);
});
