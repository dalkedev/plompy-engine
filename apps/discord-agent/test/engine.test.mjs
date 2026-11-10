import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  authorized,
  childEnvironment,
  loadConfig,
  redact,
} from "../dist/config.js";
import { Store } from "../dist/store.js";
import { codexArgs, runCodex, loginReady } from "../dist/codex.js";
import {
  assemblePrompt,
  saveTranscript,
  memoryPathAllowed,
  syncMemory,
} from "../dist/workspace.js";
import { splitMessage } from "../dist/discord.js";
import { Engine } from "../dist/engine.js";
const GUILD_ID = "111111111111111111",
  OWNER_ID = "222222222222222222",
  BOT_ID = "333333333333333333";
const identity = {
  guildId: GUILD_ID,
  ownerId: OWNER_ID,
  parentId: "444444444444444444",
};
const exec = promisify(execFile),
  parent = "444444444444444444",
  thread = "5555000000000000001",
  otherThread = "5555000000000000002";
const sid = "01a12345-1234-7456-8456-123456789abc",
  otherSid = "01a12345-1234-7456-8456-123456789def";
const mid = (n) => String(5555000000000001000n + BigInt(n));
const message = (id = mid(1), overrides = {}) => ({
  id,
  guildId: GUILD_ID,
  authorId: OWNER_ID,
  bot: false,
  webhook: false,
  channelId: thread,
  parentId: parent,
  thread: true,
  content: "Remember this and help me.",
  attachments: 0,
  ...overrides,
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "szpont-test-"));
  for (const directory of [
    "workspace",
    "state",
    "artifacts",
    "codex",
    "browser",
    "workspace/agent/memory",
    "workspace/agent/conversations",
    "workspace/agent/journal",
  ])
    await mkdir(join(root, directory), { recursive: true });
  for (const name of ["SOUL", "USER", "MEMORY", "POLICY"])
    await writeFile(
      join(root, `workspace/agent/${name}.md`),
      `# ${name}\nKnown ${name.toLowerCase()} context.`,
    );
  const config = {
    guildId: GUILD_ID,
    ownerId: OWNER_ID,
    botId: BOT_ID,
    token: "not-a-real-discord-secret",
    parentId: parent,
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    codexHome: join(root, "codex"),
    browserDir: join(root, "browser"),
    codexBin: "codex",
    timeoutMs: 1000,
  };
  return { root, config, store: new Store(join(root, "state/agent.sqlite")) };
}
function queueState(store) {
  return {
    jobs: store.db.prepare("SELECT * FROM jobs ORDER BY id").all(),
    conversations: store.db
      .prepare("SELECT * FROM conversations ORDER BY thread_id")
      .all(),
  };
}
test("authorization accepts only verified owner messages in configured private forum threads", () => {
  assert.equal(authorized(message(), identity), true);
  for (const patch of [
    { guildId: null },
    { guildId: "5555000000000000999" },
    { authorId: "5555000000000000999" },
    { bot: true },
    { webhook: true },
    { thread: false, channelId: parent, parentId: null },
    { parentId: "5555000000000000999" },
    { content: "x".repeat(8001) },
    { content: "" },
    { attachments: 1 },
  ])
    assert.equal(
      authorized(message(mid(1), patch), identity),
      false,
      JSON.stringify(patch),
    );
});
test("child env is an allowlist preserving browser setup while excluding tokens and deploy credentials", async () => {
  const { config, store } = await fixture();
  try {
    const result = childEnvironment(config, {
      PATH: "/safe/bin",
      HOME: "/safe/home",
      DISPLAY: ":99",
      XAUTHORITY: "/private/xauthority",
      CAMOUFOX_EXECUTABLE_PATH: "/opt/camoufox",
      XDG_CACHE_HOME: "/cache",
      DISCORD_BOT_TOKEN: config.token,
      OPENAI_API_KEY: "blocked",
      GITHUB_TOKEN: "blocked",
      GIT_SSH_COMMAND: "blocked",
      SZPONT_GIT_SSH_COMMAND: "blocked",
      SSH_AUTH_SOCK: "/blocked",
    });
    assert.equal(result.DISPLAY, ":99");
    assert.equal(result.XAUTHORITY, "/private/xauthority");
    assert.equal(result.CODEX_HOME, config.codexHome);
    assert.equal(result.CAMOUFOX_EXECUTABLE_PATH, "/opt/camoufox");
    assert.equal(result.XDG_CACHE_HOME, "/cache");
    for (const key of [
      "DISCORD_BOT_TOKEN",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "GIT_SSH_COMMAND",
      "SZPONT_GIT_SSH_COMMAND",
      "SSH_AUTH_SOCK",
    ])
      assert.equal(result[key], undefined);
    assert.doesNotMatch(
      redact("oops " + config.token, config.token),
      new RegExp(config.token),
    );
  } finally {
    store.close();
  }
});
test("queue deduplicates message IDs and globally serializes different threads", async () => {
  const { store } = await fixture();
  try {
    assert.equal(store.enqueue(mid(1), thread, "first"), true);
    assert.equal(store.enqueue(mid(1), thread, "different"), false);
    store.enqueue(mid(2), otherThread, "second");
    const first = store.claim();
    assert.equal(first.id, mid(1));
    assert.equal(store.claim(), undefined);
    store.finish(first.id, "succeeded", "done");
    assert.equal(store.claim().id, mid(2));
  } finally {
    store.close();
  }
});
test("restart interrupts running work, never automatically claims it again, and preserves queued other threads", async () => {
  const f = await fixture();
  const path = join(f.root, "state/agent.sqlite");
  f.store.enqueue(mid(1), thread, "publish once");
  f.store.enqueue(mid(2), thread, "followup");
  f.store.enqueue(mid(3), otherThread, "other");
  f.store.claim();
  f.store.setSession(thread, sid);
  f.store.close();
  const store = new Store(path);
  try {
    assert.equal(store.recoverStartup(), 1);
    assert.equal(store.get(mid(1)).status, "interrupted");
    assert.equal(store.session(thread), sid);
    assert.equal(store.claim().id, mid(3));
  } finally {
    store.close();
  }
});
test("explicit recovery supersedes old queued messages and does not reblock on a later restart", async () => {
  const { store } = await fixture();
  try {
    store.enqueue(mid(1), thread, "publish");
    store.claim();
    store.finish(mid(1), "interrupted", "partial", "task_timeout");
    store.enqueue(mid(2), thread, "stale followup");
    store.recover(mid(1), thread, mid(3));
    assert.equal(store.get(mid(2)).status, "cancelled");
    const recovery = store.claim();
    assert.equal(recovery.id, mid(3));
    assert.match(recovery.prompt, /Never blindly repeat a publication/);
    store.finish(recovery.id, "succeeded", "reconciled");
    store.recoverStartup();
    store.enqueue(mid(4), thread, "new followup");
    assert.equal(store.claim().id, mid(4));
  } finally {
    store.close();
  }
});
test("recovery replaces all eight queued followups in a full blocked thread", async () => {
  const { store } = await fixture();
  try {
    store.enqueue(mid(1), thread, "original request");
    store.claim();
    store.finish(mid(1), "failed", "partial", "turn_failed");
    store.setSession(thread, sid);
    for (let i = 2; i <= 9; i++)
      store.enqueue(mid(i), thread, `stale followup ${i}`);
    assert.throws(
      () => store.enqueue(mid(10), thread, "overflow"),
      /Queue is full/,
    );
    assert.equal(store.claim(), undefined);

    assert.equal(store.recover(mid(1), thread, mid(11)), true);
    for (let i = 2; i <= 9; i++) {
      const superseded = store.get(mid(i));
      assert.equal(superseded.status, "cancelled");
      assert.equal(superseded.error_code, "superseded_by_recovery");
      assert.equal(typeof superseded.finished_at, "number");
    }
    assert.equal(store.session(thread), sid);
    assert.equal(store.get(mid(1)).status, "failed");
    const recovery = store.claim();
    assert.equal(recovery.id, mid(11));
    assert.equal(recovery.recovery_of, mid(1));
    assert.match(recovery.prompt, /Original request:\n\noriginal request$/);
  } finally {
    store.close();
  }
});
test("recovery at global capacity reuses its superseded slots and preserves other threads", async () => {
  const { store } = await fixture();
  try {
    store.enqueue(mid(1), thread, "original request");
    store.claim();
    store.finish(mid(1), "interrupted", "partial", "task_timeout");
    for (let i = 2; i <= 9; i++)
      store.enqueue(mid(i), thread, `stale followup ${i}`);
    for (let i = 0; i < 22; i++)
      store.enqueue(
        mid(100 + i),
        String(BigInt(otherThread) + BigInt(Math.floor(i / 8))),
        `other thread request ${i}`,
      );
    const unrelatedBefore = {
      jobs: store.db
        .prepare("SELECT * FROM jobs WHERE thread_id<>? ORDER BY id")
        .all(thread),
      conversations: store.db
        .prepare(
          "SELECT * FROM conversations WHERE thread_id<>? ORDER BY thread_id",
        )
        .all(thread),
    };
    assert.throws(
      () => store.enqueue(mid(200), otherThread, "overflow"),
      /Queue is full/,
    );

    assert.equal(store.recover(mid(1), thread, mid(201)), true);
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) n FROM jobs WHERE status IN('queued','running')",
        )
        .get().n,
      23,
    );
    assert.deepEqual(
      {
        jobs: store.db
          .prepare("SELECT * FROM jobs WHERE thread_id<>? ORDER BY id")
          .all(thread),
        conversations: store.db
          .prepare(
            "SELECT * FROM conversations WHERE thread_id<>? ORDER BY thread_id",
          )
          .all(thread),
      },
      unrelatedBefore,
    );
    assert.equal(store.get(mid(201)).status, "queued");
    assert.equal(
      store.db
        .prepare("SELECT blocked_reason FROM conversations WHERE thread_id=?")
        .get(thread).blocked_reason,
      null,
    );
  } finally {
    store.close();
  }
});
test("invalid and duplicate recovery requests preserve queued work and the blocked state", async () => {
  const { store } = await fixture();
  try {
    store.enqueue(mid(1), thread, "original request");
    store.claim();
    store.finish(mid(1), "failed", "partial", "turn_failed");
    store.enqueue(mid(2), thread, "keep this followup");
    store.enqueue(mid(3), otherThread, "keep this other thread");
    const before = queueState(store);

    for (const [target, targetThread, newId, error] of [
      [mid(99), thread, mid(4), /Only an interrupted\/failed job/],
      [mid(1), otherThread, mid(4), /Only an interrupted\/failed job/],
      [mid(2), thread, mid(4), /Only an interrupted\/failed job/],
      [mid(1), thread, "invalid", /Invalid queue identity/],
    ]) {
      assert.throws(() => store.recover(target, targetThread, newId), error);
      assert.deepEqual(queueState(store), before);
    }
    for (const duplicate of [mid(1), mid(2), mid(3)]) {
      assert.equal(store.recover(mid(1), thread, duplicate), false);
      assert.deepEqual(queueState(store), before);
    }
    assert.equal(store.claim().id, mid(3));
  } finally {
    store.close();
  }
});
test("recovery cannot exceed global capacity occupied entirely by other threads", async () => {
  const { store } = await fixture();
  try {
    store.enqueue(mid(1), thread, "original request");
    store.claim();
    store.finish(mid(1), "failed", "partial", "turn_failed");
    for (let i = 0; i < 30; i++)
      store.enqueue(
        mid(100 + i),
        String(BigInt(otherThread) + BigInt(Math.floor(i / 8))),
        `other thread request ${i}`,
      );
    const before = queueState(store);
    assert.throws(
      () => store.recover(mid(1), thread, mid(200)),
      /Queue is full/,
    );
    assert.deepEqual(queueState(store), before);
  } finally {
    store.close();
  }
});
test("recovery rolls back cancellation, insertion and unblocking when a write fails", async (t) => {
  for (const [phase, trigger] of [
    ["insertion", "BEFORE INSERT ON jobs WHEN NEW.recovery_of IS NOT NULL"],
    [
      "unblocking",
      "BEFORE UPDATE OF blocked_reason ON conversations WHEN NEW.blocked_reason IS NULL",
    ],
  ])
    await t.test(phase, async () => {
      const { store } = await fixture();
      try {
        store.enqueue(mid(1), thread, "original request");
        store.claim();
        store.finish(mid(1), "failed", "partial", "turn_failed");
        store.enqueue(mid(2), thread, "keep this followup");
        store.enqueue(mid(3), otherThread, "keep this other thread");
        const before = queueState(store);
        store.db.exec(
          `CREATE TEMP TRIGGER reject_recovery ${trigger} BEGIN SELECT RAISE(ABORT,'injected recovery failure'); END`,
        );
        assert.throws(
          () => store.recover(mid(1), thread, mid(4)),
          /injected recovery failure/,
        );
        assert.deepEqual(queueState(store), before);
        store.db.exec("DROP TRIGGER reject_recovery");
        assert.equal(store.recover(mid(1), thread, mid(4)), true);
      } finally {
        store.close();
      }
    });
});
test("thread session mapping is independent and refuses accidental cross-thread reuse", async () => {
  const { store } = await fixture();
  try {
    store.enqueue(mid(1), thread, "one");
    store.enqueue(mid(2), otherThread, "two");
    store.setSession(thread, sid);
    store.setSession(otherThread, otherSid);
    assert.equal(store.session(thread), sid);
    assert.equal(store.session(otherThread), otherSid);
    assert.throws(() => store.setSession(otherThread, sid));
    assert.throws(() => store.setSession(thread, "--last"));
  } finally {
    store.close();
  }
});
test("a sending notification at crash becomes ambiguous, never automatically resent", async () => {
  const { store } = await fixture();
  try {
    store.enqueue(mid(1), thread, "one");
    store.claim();
    store.finish(mid(1), "succeeded", "done");
    store.notification(mid(1), "sending");
    store.recoverStartup();
    assert.equal(store.pendingNotification(), undefined);
    assert.equal(store.get(mid(1)).notification, "ambiguous");
  } finally {
    store.close();
  }
});
test("Codex arguments enforce sandbox/network policy, exact session and no model or last-session shortcut", async () => {
  const { config, store } = await fixture();
  try {
    for (const session of [null, sid]) {
      const args = codexArgs(config, session);
      assert.ok(args.includes("workspace-write"));
      assert.ok(args.includes("never"));
      assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
      assert.ok(args.includes("--json"));
      assert.ok(!args.includes("--model"));
      assert.ok(!args.includes("--last"));
      assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
      if (session) assert.ok(args.includes(session));
    }
  } finally {
    store.close();
  }
});
test("prompt assembles personality, policy, durable memory and current instruction with safe bounded files", async () => {
  const { config, store, root } = await fixture();
  try {
    store.enqueue(mid(1), thread, "Explain the concrete timeout.");
    const job = store.claim();
    await saveTranscript(config, store, thread);
    const prompt = await assemblePrompt(config, job);
    for (const name of ["soul", "user", "memory", "policy"])
      assert.match(prompt, new RegExp(`Known ${name} context`));
    assert.match(prompt, /Current verified owner instruction/);
    assert.ok(Buffer.byteLength(prompt) <= 65536);
    const transcript = await readFile(
      join(config.workspace, `agent/conversations/${thread}.md`),
      "utf8",
    );
    assert.match(transcript, /Explain the concrete timeout/);
    await writeFile(join(root, "outside"), "private");
    await symlink(
      join(root, "outside"),
      join(config.workspace, "agent/memory/2026-11-02-secret.md"),
    );
    await assert.rejects(assemblePrompt(config, job), /Unsafe workspace file/);
  } finally {
    store.close();
  }
});
test("long Discord chunks preserve every code point and obey the content ceiling", () => {
  const original = ("hello 👋🏽\n" + "x".repeat(2000) + "\n").repeat(8);
  const chunks = splitMessage(original);
  assert.equal(chunks.join(""), original);
  assert.ok(chunks.every((c) => c.length <= 1800));
  assert.ok(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c)));
});
test("memory commits include allowed Markdown only, leaving code changes unstaged", async () => {
  const { config, store } = await fixture();
  try {
    await exec("git", ["init", "-b", "memory"], { cwd: config.workspace });
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "add",
        ".",
      ],
      { cwd: config.workspace },
    );
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "initial",
      ],
      { cwd: config.workspace },
    );
    await writeFile(
      join(config.workspace, "agent/MEMORY.md"),
      "Remember a verified preference.",
    );
    await writeFile(join(config.workspace, "outside-code.ts"), "do not commit");
    assert.equal(await syncMemory(config, mid(1)), "committed");
    const changed = (
      await exec("git", ["show", "--pretty=format:", "--name-only", "HEAD"], {
        cwd: config.workspace,
      })
    ).stdout.trim();
    assert.equal(changed, "agent/MEMORY.md");
    const status = (
      await exec("git", ["status", "--porcelain"], { cwd: config.workspace })
    ).stdout;
    assert.match(status, /outside-code.ts/);
    assert.equal(memoryPathAllowed("agent/POLICY.md"), false);
    assert.equal(memoryPathAllowed("agent/memory/../../secret.md"), false);
  } finally {
    store.close();
  }
});
async function fakeCodex(config, body) {
  const path = join(config.stateDir, "fake-codex.mjs");
  await writeFile(path, "#!/usr/bin/env node\n" + body);
  await chmod(path, 0o700);
  return { ...config, codexBin: path };
}
test("runner parses JSON sessions, strips exact token from replies and discards stderr", async () => {
  const { config, store } = await fixture();
  try {
    const fake = await fakeCodex(
      config,
      `if(process.argv.includes('login'))process.exit(0);let input='';for await(const c of process.stdin)input+=c;if(process.env.DISCORD_BOT_TOKEN)throw Error('secret env leaked');process.stderr.write('sensitive diagnostic');console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(sid)}}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify("Done " + config.token + " 👋")}}}));console.log(JSON.stringify({type:'turn.completed'}));`,
    );
    assert.equal(await loginReady(fake), true);
    let saved;
    const result = await runCodex(fake, "trusted prompt", null, (id) => {
      saved = id;
    });
    assert.equal(result.ok, true);
    assert.equal(saved, sid);
    assert.match(result.output, /\[redacted\]/);
    assert.doesNotMatch(result.output, /sensitive diagnostic/);
  } finally {
    store.close();
  }
});
test("runner refuses a different resumed session without replacing the mapping", async () => {
  const { config, store } = await fixture();
  try {
    const fake = await fakeCodex(
      config,
      `console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(otherSid)}}));console.log(JSON.stringify({type:'turn.completed'}));`,
    );
    let mapped = false;
    const result = await runCodex(
      { ...fake, timeoutMs: 5000 },
      "continue",
      sid,
      () => {
        mapped = true;
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "session_identity_mismatch");
    assert.equal(mapped, false);
  } finally {
    store.close();
  }
});
test("runner preserves Polish and emoji when JSON bytes arrive in separate chunks", async () => {
  const { config, store } = await fixture();
  try {
    const text = "Zażółć gęślą jaźń 👋🏽";
    const fake = await fakeCodex(
      config,
      `const text=JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(sid)}})+'\\n'+JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(text)}}})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n';for(const byte of Buffer.from(text)){process.stdout.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,1));}`,
    );
    const result = await runCodex(
      { ...fake, timeoutMs: 3000 },
      "prompt",
      null,
      () => {},
    );
    assert.equal(result.ok, true);
    assert.equal(result.output, text);
  } finally {
    store.close();
  }
});
test("timeout stops the child and cannot be mistaken for successful completion", async () => {
  const { config, store } = await fixture();
  try {
    const fake = await fakeCodex(
      { ...config, timeoutMs: 100 },
      "setInterval(()=>{},1000);",
    );
    const result = await runCodex(fake, "wait", null, () => {});
    assert.equal(result.ok, false);
    assert.equal(result.error, "task_timeout");
  } finally {
    store.close();
  }
});
test("missing auth queues messages without starting Codex; a later authenticated tick runs them once", async () => {
  const { config, store } = await fixture();
  let ready = false,
    runs = 0;
  const sent = [];
  const deps = {
    ready: async () => ready,
    run: async (_c, _p, _s, save) => {
      runs++;
      save(sid);
      return { ok: true, output: "Done.", error: null, sessionId: sid };
    },
    persist: async () => {},
    sync: async () => "clean",
  };
  const engine = new Engine(
    config,
    store,
    {
      send: async (id, text) => {
        sent.push({ id, text });
      },
      typing: async () => {},
    },
    deps,
  );
  try {
    await engine.accept(message());
    await engine.kick();
    assert.equal(runs, 0);
    assert.equal(store.get(mid(1)).status, "queued");
    assert.ok(sent.some((s) => s.text.includes("login")));
    ready = true;
    await engine.kick();
    assert.equal(runs, 1);
    assert.equal(store.get(mid(1)).status, "succeeded");
    await engine.accept(message());
    await engine.kick();
    assert.equal(runs, 1);
  } finally {
    engine.stop();
    store.close();
  }
});
test("configuration requires a fixed parent and absolute storage paths", () => {
  assert.throws(() => loadConfig({}), /Missing/);
  assert.throws(
    () =>
      loadConfig({
        DISCORD_BOT_TOKEN: "x",
        SZPONT_DISCORD_GUILD_ID: GUILD_ID,
        SZPONT_DISCORD_OWNER_ID: OWNER_ID,
        SZPONT_DISCORD_BOT_ID: BOT_ID,
        SZPONT_DISCORD_PARENT_CHANNEL_ID: "wrong",
      }),
    /Invalid private/,
  );
});
