import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENCODE_VERSION,
  opencodeArgs,
  opencodeReady,
  runOpenCode,
} from "../dist/opencode.js";
const sid = "ses_0123456789abABCDEFGHIJKLMN";
const other = "ses_0123456789abNOPQRSTUVWXYZa";
function event(type, patch = {}) {
  const part = {
    id: `prt_${type}`,
    messageID: "msg_synthetic",
    sessionID: sid,
    type:
      type === "step_start"
        ? "step-start"
        : type === "step_finish"
          ? "step-finish"
          : type,
    ...(type === "text" ? { text: "Synthetic answer.", time: { end: 1 } } : {}),
    ...(type === "step_finish" ? { reason: "stop" } : {}),
    ...patch,
  };
  return { type, timestamp: 1, sessionID: sid, part };
}
const success = [event("step_start"), event("text"), event("step_finish")];
async function fixture(
  t,
  body,
  { version = OPENCODE_VERSION, timeoutMs = 3000 } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "szpont-opencode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of [
    "workspace",
    "state",
    "artifacts",
    "browser",
    "opencode/data/opencode",
  ])
    await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, "opencode/data/opencode/auth.json"),
    JSON.stringify({
      synthetic: { type: "api", key: "synthetic-private-key" },
    }),
    { mode: 0o600 },
  );
  const bin = join(root, "fake-opencode.mjs");
  await writeFile(
    bin,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }
let input=""; process.stdin.on("data", x => input+=x); process.stdin.on("end",()=>{
writeFileSync(${JSON.stringify(join(root, "capture.json"))},JSON.stringify({args:process.argv.slice(2),env:process.env,input}));
${body ?? success.map((x) => `console.log(${JSON.stringify(JSON.stringify(x))});`).join("\n")}
});
`,
    { mode: 0o700 },
  );
  await chmod(bin, 0o700);
  return {
    root,
    config: {
      token: "synthetic-discord-token",
      provider: "opencode",
      workspace: join(root, "workspace"),
      stateDir: join(root, "state"),
      artifactsDir: join(root, "artifacts"),
      browserDir: join(root, "browser"),
      codexHome: join(root, "codex"),
      codexBin: "missing-codex",
      opencodeBin: bin,
      opencodeHome: join(root, "opencode"),
      opencodeModel: "synthetic/model",
      opencodeAllowHostExecution: true,
      timeoutMs,
    },
  };
}
const lines = (values) =>
  values
    .map((x) => `console.log(${JSON.stringify(JSON.stringify(x))});`)
    .join("\n");

test("OpenCode requires explicit host opt-in, model and compatible local CLI; readiness proves only local credentials", async (t) => {
  const { config } = await fixture(t);
  assert.equal(await opencodeReady(config), true);
  assert.equal(
    await opencodeReady({ ...config, opencodeAllowHostExecution: false }),
    false,
  );
  assert.equal(
    await opencodeReady({ ...config, opencodeModel: undefined }),
    false,
  );
  assert.equal(
    await opencodeReady({ ...config, opencodeModel: "other/model" }),
    false,
  );
  const result = await runOpenCode(
    { ...config, opencodeAllowHostExecution: false },
    "Synthetic",
    null,
    () => assert.fail(),
  );
  assert.equal(result.error, "opencode_host_execution_not_enabled");
});
for (const version of ["2.0.0", "1.19.4", "1.19.5 with extra diagnostics"]) {
  test(`OpenCode version ${version} is not accepted speculatively`, async (t) => {
    const { config } = await fixture(t, undefined, { version });
    assert.equal(await opencodeReady(config), false);
    const result = await runOpenCode(config, "Synthetic", null, () =>
      assert.fail(),
    );
    assert.equal(result.error, "opencode_local_prerequisites_unavailable");
  });
}
test("OpenCode explicitly resumes exact session with stdin, selected model, isolated env and no auto/fallback flags", async (t) => {
  const { root, config } = await fixture(t);
  const seen = [];
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "synthetic-unrelated-parent-key";
  try {
    const result = await runOpenCode(config, "Synthetic prompt", sid, (x) =>
      seen.push(x),
    );
    assert.deepEqual(result, {
      ok: true,
      output: "Synthetic answer.",
      error: null,
      sessionId: sid,
    });
    assert.deepEqual(seen, [sid]);
    const captured = JSON.parse(
      await readFile(join(root, "capture.json"), "utf8"),
    );
    assert.deepEqual(captured.args, opencodeArgs(config, sid));
    assert.equal(captured.input, "Synthetic prompt");
    assert.equal(captured.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(captured.env.CODEX_HOME, undefined);
    assert.equal(captured.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(captured.env.HOME, config.opencodeHome);
    assert.equal(captured.env.XDG_DATA_HOME, join(config.opencodeHome, "data"));
    assert.equal(captured.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
    assert.equal(captured.env.OPENCODE_PURE, "true");
    const policy = JSON.parse(captured.env.OPENCODE_PERMISSION);
    assert.equal(policy["*"], "deny");
    assert.equal(policy.question, "deny");
    assert.equal(policy.bash, "allow");
    const settings = JSON.parse(captured.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(settings.enabled_providers, ["synthetic"]);
    assert.equal(settings.share, "disabled");
    assert.deepEqual(settings.plugin, []);
    assert.ok(!captured.args.includes("--continue"));
    assert.ok(!captured.args.includes("--auto"));
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});
test("OpenCode validates session IDs before spawning", async (t) => {
  const { config } = await fixture(t);
  assert.throws(
    () => opencodeArgs(config, "01a12345-1234-7456-8456-123456789abc"),
    /Invalid OpenCode resume session/,
  );
  await assert.rejects(
    runOpenCode(config, "Synthetic", "--continue", () => {}),
    /Invalid OpenCode resume session/,
  );
});
for (const [name, body, error] of [
  ["malformed JSON", 'console.log("not json");', "invalid_opencode_json"],
  ["nonobject JSON", 'console.log("null");', "invalid_opencode_event"],
  ["missing finish", lines(success.slice(0, 2)), "opencode_turn_incomplete"],
  [
    "tool finish only",
    lines([
      event("step_start"),
      event("text"),
      event("step_finish", { reason: "tool-calls" }),
    ]),
    "opencode_turn_incomplete",
  ],
  [
    "length finish",
    lines([
      event("step_start"),
      event("text"),
      event("step_finish", { reason: "length" }),
    ]),
    "opencode_turn_incomplete",
  ],
  [
    "nonzero exit after completion",
    lines(success) + "\nprocess.exitCode=2;",
    "opencode_turn_failed",
  ],
  [
    "explicit error after completion",
    lines([
      ...success,
      {
        type: "error",
        sessionID: sid,
        error: { message: "secret upstream diagnostic" },
      },
    ]),
    "opencode_turn_failed",
  ],
  [
    "wrong top-level session",
    lines([{ ...event("step_start"), sessionID: other }]),
    "session_identity_mismatch",
  ],
  [
    "wrong part session",
    lines([event("step_start", { sessionID: other })]),
    "session_identity_mismatch",
  ],
  [
    "session changes during stream",
    lines([
      event("step_start"),
      { ...event("text", { sessionID: other }), sessionID: other },
    ]),
    "session_identity_mismatch",
  ],
  [
    "later unfinished step",
    lines([...success, event("step_start")]),
    "opencode_turn_incomplete",
  ],
  [
    "output bound",
    lines([event("step_start"), event("text", { text: "x".repeat(32001) })]),
    "agent_output_limit",
  ],
]) {
  test(`OpenCode fails closed for ${name}`, async (t) => {
    const { config } = await fixture(t, body);
    const result = await runOpenCode(config, "Synthetic", sid, () => {});
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
    assert.ok(!result.output.includes("secret upstream diagnostic"));
  });
}
test("OpenCode new session is recorded once; text is assembled from final message only, not reasoning or tool output", async (t) => {
  const { config } = await fixture(
    t,
    lines([
      event("step_start"),
      event("text", { text: "intermediate" }),
      event("reasoning", { text: "hidden" }),
      event("step_finish", { reason: "tool-calls" }),
      event("step_start", { messageID: "msg_final" }),
      event("text", { messageID: "msg_final", id: "prt_a", text: "Final" }),
      event("text", { messageID: "msg_final", id: "prt_b", text: "answer" }),
      event("step_finish", { messageID: "msg_final" }),
    ]),
  );
  const seen = [];
  const result = await runOpenCode(config, "Synthetic", null, (id) =>
    seen.push(id),
  );
  assert.equal(result.ok, true);
  assert.equal(result.output, "Final\nanswer");
  assert.deepEqual(seen, [sid]);
});
test("OpenCode persistence failure prevents success", async (t) => {
  const { config } = await fixture(t);
  assert.equal(
    (
      await runOpenCode(config, "Synthetic", null, () => {
        throw new Error("database unavailable");
      })
    ).error,
    "session_persistence_failed",
  );
});
for (const cancel of [false, true]) {
  test(`OpenCode ${cancel ? "cancellation" : "timeout"} keeps primary cause despite graceful error event`, async (t) => {
    const { config } = await fixture(
      t,
      `process.on("SIGTERM",()=>{console.log(JSON.stringify({type:"error",sessionID:${JSON.stringify(sid)}}));process.exit(0)});\n${lines([event("step_start")])}\nsetInterval(()=>{},1000);`,
      { timeoutMs: cancel ? 5000 : 250 },
    );
    const controller = new AbortController();
    const result = await runOpenCode(
      config,
      "Synthetic",
      null,
      () => {
        if (cancel) controller.abort();
      },
      controller.signal,
    );
    assert.equal(
      result.error,
      cancel ? "owner_or_service_cancelled" : "task_timeout",
    );
  });
}
test("OpenCode workflow output has strict checkpoint validation and no Markdown recovery", async (t) => {
  const valid = JSON.stringify({
    outcome: "completed",
    summary: "Synthetic verification complete.",
    nextAction: "",
  });
  const { config, root } = await fixture(
    t,
    lines([
      event("step_start"),
      event("text", { text: valid }),
      event("step_finish"),
    ]),
  );
  assert.equal(
    (
      await runOpenCode(config, "Synthetic", null, () => {}, undefined, {
        workflow: true,
      })
    ).ok,
    true,
  );
  const captured = JSON.parse(
    await readFile(join(root, "capture.json"), "utf8"),
  );
  assert.match(captured.input, /checkpoint matching this schema/);
  const invalid = await fixture(t);
  const result = await runOpenCode(
    invalid.config,
    "Synthetic",
    null,
    () => {},
    undefined,
    { workflow: true },
  );
  assert.equal(result.error, "workflow_output_invalid");
});
test("OpenCode accepts only explicit private provider/MCP config and denies policy/plugin injection", async (t) => {
  const { config, root } = await fixture(t);
  const path = join(root, "trusted-config.json");
  await writeFile(
    path,
    JSON.stringify({
      provider: {
        synthetic: { options: { baseURL: "https://example.invalid" } },
      },
      mcp: {
        synthetic: {
          type: "remote",
          url: "https://example.invalid/mcp",
          enabled: true,
        },
      },
    }),
  );
  assert.equal(await opencodeReady({ ...config, opencodeConfig: path }), true);
  await writeFile(
    path,
    JSON.stringify({ permission: "allow", plugin: ["not-installed"] }),
  );
  assert.equal(await opencodeReady({ ...config, opencodeConfig: path }), false);
});
test("OpenCode rejects well-known credentials, missing credentials and secret-bearing malformed auth without logging them", async (t) => {
  const { config } = await fixture(t);
  for (const value of [
    { synthetic: { type: "wellknown", key: "secret", token: "secret" } },
    { synthetic: { type: "api", key: "" } },
    { synthetic: { type: "oauth", access: "a", refresh: "r", expires: -1 } },
    {},
  ]) {
    await writeFile(
      join(config.opencodeHome, "data/opencode/auth.json"),
      JSON.stringify(value),
    );
    assert.equal(await opencodeReady(config), false);
  }
});

test(
  "OpenCode hard deadline reaps descendants even after the CLI leader exits",
  { skip: process.platform === "win32" },
  async (t) => {
    const { config } = await fixture(
      t,
      `${lines([event("step_start")])}\nconst {spawn}=await import("node:child_process");\nspawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});\nprocess.exit(0);`,
      { timeoutMs: 250 },
    );
    // The fixture handler is synchronous, so use a static import for this script.
    const source = await readFile(config.opencodeBin, "utf8");
    await writeFile(
      config.opencodeBin,
      source
        .replace(
          'import { writeFileSync } from "node:fs";',
          'import { writeFileSync } from "node:fs"; import {spawn} from "node:child_process";',
        )
        .replace('const {spawn}=await import("node:child_process");', ""),
    );
    const started = performance.now();
    const result = await runOpenCode(config, "Synthetic", null, () => {});
    assert.equal(result.error, "task_timeout");
    assert.ok(performance.now() - started < 6000);
  },
);
for (const [name, body, expected] of [
  [
    "oversized JSON line",
    'process.stdout.write("x".repeat(512*1024+1));',
    "event_line_limit",
  ],
  [
    "stderr flood",
    'process.stderr.write("x".repeat(256*1024+1)); setInterval(()=>{},1000);',
    "stderr_limit",
  ],
]) {
  test(`OpenCode bounds ${name}`, async (t) => {
    const { config } = await fixture(t, body);
    assert.equal(
      (await runOpenCode(config, "Synthetic", null, () => {})).error,
      expected,
    );
  });
}
test("OpenCode already-aborted requests never launch a turn", async (t) => {
  const { config, root } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const result = await runOpenCode(
    config,
    "Synthetic",
    null,
    () => assert.fail(),
    controller.signal,
  );
  assert.equal(result.error, "owner_or_service_cancelled");
  await assert.rejects(readFile(join(root, "capture.json")), {
    code: "ENOENT",
  });
});

test("OpenCode final stop cannot reuse an earlier assistant message without new text", async (t) => {
  const { config } = await fixture(
    t,
    lines([
      event("step_start"),
      event("text"),
      event("step_finish", { reason: "tool-calls" }),
      event("step_start", { messageID: "msg_final" }),
      event("step_finish", { messageID: "msg_final" }),
    ]),
  );
  const result = await runOpenCode(config, "Synthetic", null, () => {});
  assert.equal(result.error, "opencode_turn_incomplete");
  assert.equal(result.output, "");
});
