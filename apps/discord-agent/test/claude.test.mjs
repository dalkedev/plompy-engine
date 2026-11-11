import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import {
  claudeArgs,
  claudeReady,
  runClaude,
  CLAUDE_MIN_VERSION,
  supportedClaudeVersion,
} from "../dist/claude.js";

const sid = "01a12345-1234-7456-8456-123456789abc";
const otherSid = "01a12345-1234-7456-8456-123456789def";
async function fixture(t, body = "") {
  const root = await mkdtemp(join(tmpdir(), "plompy-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    ["workspace", "state", "artifacts", "browser", "codex", "claude"].map(
      (path) => mkdir(join(root, path)),
    ),
  );
  const bin = join(root, "fake claude.mjs");
  await writeFile(bin, script(body));
  await chmod(bin, 0o700);
  return {
    root,
    config: {
      provider: "claude",
      token: "synthetic-discord-secret",
      guildId: "111111111111111111",
      ownerId: "222222222222222222",
      botId: "333333333333333333",
      parentId: "444444444444444444",
      workspace: join(root, "workspace"),
      stateDir: join(root, "state"),
      artifactsDir: join(root, "artifacts"),
      browserDir: join(root, "browser"),
      codexHome: join(root, "codex"),
      claudeHome: join(root, "claude"),
      opencodeHome: join(root, "opencode"),
      codexBin: "codex",
      claudeBin: bin,
      timeoutMs: 1500,
    },
  };
}
const prelude =
  "let prompt='';for await(const c of process.stdin)prompt+=c;\n" +
  "const flag=process.argv.includes('--resume')?'--resume':'--session-id';\n" +
  "const session=process.argv[process.argv.indexOf(flag)+1];\n" +
  "const emit=e=>console.log(JSON.stringify(e));\n" +
  "emit({type:'system',subtype:'init',session_id:session});\n";
const success =
  "emit({type:'result',subtype:'success',session_id:session,is_error:false,result:'Done.'});";
function script(body) {
  const versionProbe = body.includes("--version")
    ? ""
    : "if(process.argv.includes('--version')){console.log('2.1.285 (Claude Code)');process.exit(0)}\n";
  return "#!/usr/bin/env node\n" + versionProbe + body;
}

test("Claude args use restricted permissions and a required sandbox without bypass", async (t) => {
  const { config } = await fixture(t);
  const args = claudeArgs(
    { ...config, claudeModel: "sonnet", claudeEffort: "high" },
    sid,
    false,
    { workflow: true },
  );
  const value = (flag) => args[args.indexOf(flag) + 1];
  for (const flag of [
    "--restricted",
    "--disable-slash-commands",
    "--no-chrome",
    "--strict-mcp-config",
    "--verbose",
  ])
    assert.ok(args.includes(flag), flag);
  assert.equal(value("--setting-sources"), "");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--output-format"), "stream-json");
  assert.equal(value("--session-id"), sid);
  assert.equal(value("--model"), "sonnet");
  assert.equal(value("--effort"), "high");
  assert.equal(value("--mcp-config"), '{"mcpServers":{}}');
  const settings = JSON.parse(value("--settings"));
  assert.equal(settings.disableAllHooks, true);
  assert.deepEqual(settings.enabledPlugins, {});
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.excludedCommands, []);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, [
    config.artifactsDir,
    config.browserDir,
  ]);
  assert.ok(settings.sandbox.filesystem.denyRead.includes(config.claudeHome));
  assert.ok(settings.sandbox.filesystem.denyRead.includes(config.opencodeHome));
  assert.equal(JSON.parse(value("--json-schema")).additionalProperties, false);
  for (const flag of [
    "--bare",
    "--continue",
    "--dangerously-skip-permissions",
    "--fallback-model",
    "--fork-session",
  ])
    assert.ok(!args.includes(flag), flag);
  const resumed = claudeArgs(config, sid, true);
  assert.equal(resumed[resumed.indexOf("--resume") + 1], sid);
  assert.ok(!resumed.includes("--session-id"));
  assert.throws(
    () => claudeArgs(config, "latest", true),
    /Invalid resume session/,
  );
});

test("Claude grants MCP tool permissions only for an explicit operator config", async (t) => {
  const { config } = await fixture(t);
  const path = join(config.stateDir, "operator-mcp.json");
  const args = claudeArgs({ ...config, claudeMcpConfig: path }, sid, true);
  assert.equal(args[args.indexOf("--mcp-config") + 1], path);
  assert.match(args[args.indexOf("--allowedTools") + 1], /mcp__\*/);
  const defaults = claudeArgs(config, sid, true);
  assert.doesNotMatch(
    defaults[defaults.indexOf("--allowedTools") + 1],
    /mcp__/,
  );
});

test("Claude consumes the wizard's discovered private MCP configuration in its actual child arguments", async (t) => {
  const { config: fixtureConfig, root } = await fixture(t);
  const path = join(fixtureConfig.claudeHome, "plompy-mcp.json");
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: {
        plompy_context7: { type: "http", url: "https://example.test/mcp" },
      },
    }),
    { mode: 0o600 },
  );
  const capture = join(root, "integration-child.json");
  await writeFile(
    fixtureConfig.claudeBin,
    script(
      "import {writeFileSync} from 'node:fs';\n" +
        `writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),gh:process.env.GH_CONFIG_DIR}));\n` +
        prelude +
        success,
    ),
  );
  const config = loadConfig({
    DISCORD_BOT_TOKEN: fixtureConfig.token,
    PLOMPY_DISCORD_GUILD_ID: fixtureConfig.guildId,
    PLOMPY_DISCORD_OWNER_ID: fixtureConfig.ownerId,
    PLOMPY_DISCORD_BOT_ID: fixtureConfig.botId,
    PLOMPY_DISCORD_PARENT_CHANNEL_ID: fixtureConfig.parentId,
    PLOMPY_WORKSPACE: fixtureConfig.workspace,
    PLOMPY_STATE_DIR: fixtureConfig.stateDir,
    PLOMPY_ARTIFACTS_DIR: fixtureConfig.artifactsDir,
    PLOMPY_BROWSER_DIR: fixtureConfig.browserDir,
    PLOMPY_RUNNER: "claude",
    CLAUDE_CONFIG_DIR: fixtureConfig.claudeHome,
    PLOMPY_CLAUDE_BIN: fixtureConfig.claudeBin,
  });
  assert.equal(config.claudeMcpConfig, path);
  const result = await runClaude(
    config,
    "Synthetic integration check",
    null,
    () => {},
  );
  assert.equal(result.ok, true);
  const child = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(child.args[child.args.indexOf("--mcp-config") + 1], path);
  assert.ok(child.args.includes("--strict-mcp-config"));
  assert.match(child.args[child.args.indexOf("--allowedTools") + 1], /mcp__\*/);
  assert.equal(child.gh, config.githubConfigDir);
});

test("Claude readiness checks minimum version before the read-only login probe", async (t) => {
  const { config, root } = await fixture(t);
  const marker = join(root, "probe-ran");
  await writeFile(
    config.claudeBin,
    script(
      "import {writeFileSync} from 'node:fs';\n" +
        "if(process.argv.includes('--version')){console.log('" +
        CLAUDE_MIN_VERSION +
        " (Claude Code)');process.exit(0)}\n" +
        "if(process.argv.slice(2).join(' ')==='auth status'){writeFileSync(" +
        JSON.stringify(marker) +
        ",'checked');console.log('private account metadata');process.exit(0)}\nprocess.exit(9);",
    ),
  );
  assert.equal(await claudeReady(config), true);
  assert.equal(await readFile(marker, "utf8"), "checked");
  await writeFile(
    config.claudeBin,
    script(
      "if(process.argv.includes('--version')){console.log('2.1.197 (Claude Code)');process.exit(0)}throw Error('must not probe auth');",
    ),
  );
  assert.equal(await claudeReady(config), false);
  for (const version of [
    "unexpected",
    "2.1.284 (Claude Code)",
    "2.1.285-beta (Claude Code)",
    "3.0.0 (Claude Code)",
  ])
    assert.equal(supportedClaudeVersion(version), false);
  assert.equal(supportedClaudeVersion("2.1.285 (Claude Code)\n"), true);
  assert.equal(supportedClaudeVersion("2.2.0 (Claude Code)"), true);
});

test("Claude readiness rejects logged-out state and missing binaries", async (t) => {
  const { config } = await fixture(
    t,
    "if(process.argv.includes('--version')){console.log('2.1.285 (Claude Code)');process.exit(0)}process.exit(1);",
  );
  assert.equal(await claudeReady(config), false);
  assert.equal(
    await claudeReady({ ...config, claudeBin: "/definitely/missing/claude" }),
    false,
  );
});

test("Claude consumes completed results, preserves UTF-8 and hides secrets and diagnostics", async (t) => {
  const text = "Zażółć gęślą 👋 synthetic-discord-secret";
  const { config } = await fixture(
    t,
    prelude +
      "if(!prompt.includes('trusted prompt'))throw Error('stdin missing');\n" +
      "if(process.env.DISCORD_BOT_TOKEN||process.env.CODEX_HOME||process.env.ANTHROPIC_API_KEY)throw Error('credentials leaked');\n" +
      "if(!process.env.CLAUDE_CONFIG_DIR)throw Error('missing private config');\n" +
      "process.stderr.write('never expose this diagnostic');\n" +
      "emit({type:'assistant',session_id:session,message:{content:[{type:'text',text:'intermediate ignored'}]}});\n" +
      "const encoded=Buffer.from(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:session,result:" +
      JSON.stringify(text) +
      "})+'\\n');for(const byte of encoded)process.stdout.write(Buffer.from([byte]));",
  );
  let saved;
  const result = await runClaude(config, "trusted prompt", null, (id) => {
    saved = id;
  });
  assert.equal(result.ok, true);
  assert.match(saved, /^[a-f0-9-]{36}$/);
  assert.equal(result.sessionId, saved);
  assert.equal(result.output, "Zażółć gęślą 👋 [redacted]");
  assert.equal(result.error, null);
});

test("Claude workflows accept only validated structured output", async (t) => {
  const checkpoint = {
    outcome: "continue",
    summary: "Observed fixture test pass.",
    nextAction: "Check the synthetic report.",
  };
  const { config } = await fixture(t);
  const body = (value) =>
    script(
      prelude +
        "emit({type:'result',subtype:'success',session_id:session,is_error:false,result:'not a checkpoint',structured_output:" +
        JSON.stringify(value) +
        "});",
    );
  await writeFile(config.claudeBin, body(checkpoint));
  const result = await runClaude(config, "workflow", sid, () => {}, undefined, {
    workflow: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), checkpoint);
  for (const value of [
    undefined,
    { ...checkpoint, extra: true },
    { ...checkpoint, nextAction: "" },
  ]) {
    await writeFile(config.claudeBin, body(value));
    const invalid = await runClaude(
      config,
      "workflow",
      sid,
      () => {},
      undefined,
      { workflow: true },
    );
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error, "workflow_output_invalid");
  }
});

test("Claude rejects changed sessions before persisting a mapping", async (t) => {
  const { config } = await fixture(
    t,
    "console.log(JSON.stringify({type:'system',subtype:'init',session_id:'" +
      otherSid +
      "'}));",
  );
  let persisted = false;
  const result = await runClaude(config, "resume", sid, () => {
    persisted = true;
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "session_identity_mismatch");
  assert.equal(persisted, false);
});

test("Claude rejects mismatched result identities and mapping persistence errors", async (t) => {
  const { config } = await fixture(
    t,
    prelude +
      "emit({type:'result',subtype:'success',session_id:'" +
      otherSid +
      "',is_error:false,result:'Done.'});",
  );
  assert.equal(
    (await runClaude(config, "resume", sid, () => {})).error,
    "session_identity_mismatch",
  );
  await writeFile(config.claudeBin, script(prelude + success));
  assert.equal(
    (
      await runClaude(config, "resume", sid, () => {
        throw Error("database unavailable");
      })
    ).error,
    "session_persistence_failed",
  );
});

test("Claude requires a successful completed result and a zero process exit", async (t) => {
  const { config } = await fixture(t);
  for (const body of [
    prelude,
    prelude + success + "process.exitCode=1;",
    prelude +
      "emit({type:'result',subtype:'error_during_execution',is_error:true,session_id:session,errors:['private']});",
    prelude +
      "emit({type:'result',subtype:'success',is_error:true,session_id:session,result:'failure'});",
  ]) {
    await writeFile(config.claudeBin, script(body));
    const result = await runClaude(config, "synthetic", sid, () => {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "claude_turn_failed");
    assert.doesNotMatch(result.output, /private/);
  }
});

test("Claude rejects malformed events, oversized outputs and absent result text", async (t) => {
  const { config } = await fixture(t);
  for (const [body, error] of [
    ["console.log('not json');", "invalid_claude_json"],
    ["console.log('[]');", "invalid_claude_event"],
    [
      prelude +
        "emit({type:'result',subtype:'success',is_error:false,session_id:session,result:'x'.repeat(32001)});",
      "agent_output_limit",
    ],
    [
      prelude +
        "emit({type:'result',subtype:'success',is_error:false,session_id:session});",
      "claude_result_invalid",
    ],
    ["process.stdout.write('x'.repeat(530000));", "event_line_limit"],
    ["process.stderr.write('x'.repeat(270000));", "stderr_limit"],
  ]) {
    await writeFile(config.claudeBin, script(body));
    const result = await runClaude(config, "synthetic", sid, () => {});
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
  }
});

test("Claude timeout and cancellation keep their first stop reason", async (t) => {
  const { config } = await fixture(
    t,
    "process.on('SIGTERM',()=>{console.log(JSON.stringify({type:'error',message:'shutdown'}));process.exit(1)});setInterval(()=>{},50);",
  );
  const timed = await runClaude(
    { ...config, timeoutMs: 300 },
    "synthetic",
    sid,
    () => {},
  );
  assert.equal(timed.ok, false);
  assert.equal(timed.error, "task_timeout");
  const abort = new AbortController();
  const run = runClaude(config, "synthetic", sid, () => {}, abort.signal);
  setTimeout(() => abort.abort(), 250);
  const cancelled = await run;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error, "owner_or_service_cancelled");
});

test("Claude missing executable and invalid input never imply success", async (t) => {
  const { config } = await fixture(t);
  assert.equal(
    (
      await runClaude(
        { ...config, claudeBin: "/definitely/missing/claude" },
        "synthetic",
        null,
        () => {},
      )
    ).error,
    "claude_process_unavailable",
  );
  assert.throws(
    () => runClaude(config, "x".repeat(65537), null, () => {}),
    /prompt exceeds limit/,
  );
  assert.throws(
    () => runClaude(config, "synthetic", "latest", () => {}),
    /Invalid resume session/,
  );
});

test("Claude rejects unsupported versions before starting a model process", async (t) => {
  const { config } = await fixture(
    t,
    "if(process.argv.includes('--version')){console.log('2.1.284 (Claude Code)');process.exit(0)}throw Error('must not run');",
  );
  const result = await runClaude(config, "synthetic", sid, () => {
    throw Error("must not persist");
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "claude_version_unsupported");
});

test("Claude rejects repeated init and result messages", async (t) => {
  const { config } = await fixture(t);
  for (const [tail, error] of [
    [
      "emit({type:'system',subtype:'init',session_id:session});",
      "session_identity_mismatch",
    ],
    [success + success, "claude_duplicate_result"],
  ]) {
    await writeFile(config.claudeBin, script(prelude + tail));
    const result = await runClaude(config, "synthetic", sid, () => {});
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
  }
});

test("Claude never changes mappings after a malformed event has stopped the turn", async (t) => {
  const { config } = await fixture(
    t,
    "console.log('bad-json');" + prelude + success,
  );
  let saved = false;
  const result = await runClaude(config, "synthetic", null, () => {
    saved = true;
  });
  assert.equal(result.error, "invalid_claude_json");
  assert.equal(saved, false);
});

test(
  "Claude escalates against descendants after the process-group leader exits",
  { skip: process.platform === "win32", timeout: 8000 },
  async (t) => {
    const { config } = await fixture(
      t,
      "import {spawn} from 'node:child_process';\n" +
        "spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},50)\"],{stdio:'inherit'});\n" +
        "process.on('SIGTERM',()=>process.exit(1));setInterval(()=>{},50);",
    );
    const result = await runClaude(
      { ...config, timeoutMs: 600 },
      "synthetic",
      sid,
      () => {},
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "task_timeout");
  },
);
