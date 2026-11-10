import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  chmod,
  stat,
  lstat,
  readdir,
  rm,
  access,
  symlink,
  link,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import {
  setup,
  SetupError,
  parseSetupArguments,
  readHiddenToken,
  readTokenStdin,
  nextSteps,
} from "./setup.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./setup.mjs", import.meta.url));
const compiledConfig = fileURLToPath(
  new URL("../apps/discord-agent/dist/config.js", import.meta.url),
);
const ids = {
  guildId: "111111111111111111",
  ownerId: "222222222222222222",
  botId: "333333333333333333",
  forumId: "444444444444444444",
};
const syntheticToken = "synthetic-token-'-$() `quoted`-not-a-credential";
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "szpont-setup-")));
  await chmod(base, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));
  const tokenFile = join(base, "token");
  await writeFile(tokenFile, syntheticToken + "\n", { mode: 0o600 });
  return { base, root: join(base, "private"), tokenFile, ...ids };
}
const missing = async (path) =>
  assert.rejects(access(path), { code: "ENOENT" });
async function loadGenerated(path) {
  // Source through an actual POSIX shell. Output only a hash, never token bytes.
  const code = `import {createHash} from 'node:crypto'; const {loadConfig}=await import(process.argv[1]); const c=loadConfig(process.env); delete c.token; console.log(JSON.stringify({config:c,hash:createHash('sha256').update(process.env.DISCORD_BOT_TOKEN).digest('hex')}))`;
  const { stdout } = await execute(
    "/bin/sh",
    [
      "-c",
      'set -a\n. "$1"\nset +a\nexec "$2" --input-type=module -e "$3" "$4"',
      "setup-check",
      path,
      process.execPath,
      code,
      compiledConfig,
    ],
    {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    },
  );
  return JSON.parse(stdout);
}
test("guided setup composes the real initializer/config loader and quotes paths/token for a POSIX shell", async (t) => {
  const options = await fixture(t);
  options.root = join(options.base, "space ' quote $() `ticks` ; directory");
  const result = await setup(options);
  assert.equal(result.envFile, join(options.root, "agent.env"));
  assert.equal((await stat(result.envFile)).mode & 0o777, 0o600);
  for (const name of [
    "workspace",
    "state",
    "artifacts",
    "browser",
    "codex",
    "claude",
    "opencode",
    "github",
  ])
    assert.equal((await stat(join(options.root, name))).mode & 0o777, 0o700);
  const loaded = await loadGenerated(result.envFile);
  assert.equal(
    loaded.hash,
    createHash("sha256").update(syntheticToken).digest("hex"),
  );
  assert.equal(loaded.config.workspace, join(options.root, "workspace"));
  assert.equal(loaded.config.provider, "codex");
  const git = await execute("git", ["status", "--porcelain"], {
    cwd: loaded.config.workspace,
  });
  assert.equal(git.stdout, "");
  assert.match(
    await readFile(join(loaded.config.workspace, "agent/USER.md"), "utf8"),
    /Configure/,
  );
  assert.equal(JSON.stringify(result).includes(syntheticToken), false);
  assert.equal(nextSteps(result).includes(syntheticToken), false);
});
test("all three runner defaults are accepted by compiled config without installing or logging in", async (t) => {
  for (const runner of ["codex", "claude", "opencode"]) {
    const options = await fixture(t);
    const result = await setup({
      ...options,
      runner,
      ...(runner === "opencode"
        ? { opencodeModel: "fixture/model", allowOpencodeHostExecution: true }
        : {}),
    });
    const { config } = await loadGenerated(result.envFile);
    assert.equal(config.provider, runner);
    if (runner === "claude") {
      assert.equal(config.claudeModel, "sonnet");
      assert.equal(config.claudeEffort, "high");
    }
    if (runner === "opencode") {
      assert.equal(config.opencodeModel, "fixture/model");
      assert.equal(config.opencodeAllowHostExecution, true);
    }
    await missing(join(options.root, "state/agent.sqlite"));
  }
});
test("OpenCode host execution needs separate consent; --yes does not authorize it", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    setup({
      ...options,
      runner: "opencode",
      opencodeModel: "fixture/model",
      yes: true,
    }),
    { code: "opencode" },
  );
  await missing(options.root);
});
test("existing environment files and managed workspace contents stay byte-for-byte unchanged", async (t) => {
  for (const existing of ["agent.env", "workspace"]) {
    const options = await fixture(t);
    await mkdir(options.root, { mode: 0o700 });
    const target = join(options.root, existing);
    if (existing === "workspace") await mkdir(target, { mode: 0o700 });
    const sentinel =
      existing === "workspace" ? join(target, "owner.txt") : target;
    await writeFile(sentinel, "existing owner content\n", { mode: 0o600 });
    const before = await stat(sentinel);
    await assert.rejects(setup(options), { code: "exists" });
    const after = await stat(sentinel);
    assert.equal(await readFile(sentinel, "utf8"), "existing owner content\n");
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.deepEqual(await readdir(options.root), [existing]);
  }
});
test("an existing owned private root is reused without deleting unrelated resources on rollback", async (t) => {
  const options = await fixture(t);
  await mkdir(options.root, { mode: 0o700 });
  await writeFile(join(options.root, "keep"), "owner data", { mode: 0o600 });
  await assert.rejects(
    setup(options, {
      initializeWorkspace: async (path) => {
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, "partial"), "partial");
        throw new Error(syntheticToken);
      },
    }),
    (error) =>
      error.code === "rollback" && !error.message.includes(syntheticToken),
  );
  assert.deepEqual((await readdir(options.root)).sort(), ["keep", "workspace"]);
  assert.equal(
    await readFile(join(options.root, "workspace/partial"), "utf8"),
    "partial",
  );
  assert.equal(
    await readFile(join(options.root, "keep"), "utf8"),
    "owner data",
  );
});
test("a concurrent actual initializer winner is never claimed or deleted after EEXIST", async (t) => {
  const options = await fixture(t);
  await mkdir(options.root, { mode: 0o700 });
  let actualExclusiveInitializerFailed = false;
  const initializer = fileURLToPath(
    new URL("./init-workspace.mjs", import.meta.url),
  );
  let failure;
  try {
    await setup(options, {
      initializeWorkspace: async (path) => {
        // The competing owner wins the real exclusive initializer before this
        // setup's real initializer starts; only scheduling is injected.
        await execute(process.execPath, [initializer, path]);
        await writeFile(
          join(path, "concurrent-owner-canary"),
          "other operation owns this workspace",
          { mode: 0o600 },
        );
        try {
          await execute(process.execPath, [initializer, path]);
        } catch (error) {
          actualExclusiveInitializerFailed = error.code === 1;
          throw error;
        }
        assert.fail("The real initializer must refuse an existing workspace");
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(actualExclusiveInitializerFailed, true);
  assert.equal(
    await readFile(
      join(options.root, "workspace/concurrent-owner-canary"),
      "utf8",
    ),
    "other operation owns this workspace",
  );
  assert.equal(failure?.code, "rollback");
  await missing(join(options.root, "agent.env"));
});
test("partial initialization preserves an unproven workspace and removes safe empty new parents", async (t) => {
  const options = await fixture(t);
  options.root = join(options.base, "new-parent", "private");
  options.envFile = join(options.base, "new-config", "agent.env");
  await assert.rejects(
    setup(options, {
      initializeWorkspace: async (path) => {
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, "partial"), "partial");
        throw new Error("initializer raw diagnostics " + syntheticToken);
      },
    }),
    { code: "rollback" },
  );
  assert.equal(
    await readFile(join(options.root, "workspace/partial"), "utf8"),
    "partial",
  );
  await missing(join(options.base, "new-config"));
  assert.equal(
    await readFile(options.tokenFile, "utf8"),
    syntheticToken + "\n",
  );
});
test("an environment file created concurrently is preserved instead of overwritten or deleted", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    setup(options, {
      initializeWorkspace: async (path) => {
        await mkdir(path, { mode: 0o700 });
        await writeFile(
          join(options.root, "agent.env"),
          "concurrent owner content",
          { mode: 0o600 },
        );
      },
    }),
    { code: "rollback" },
  );
  assert.equal(
    await readFile(join(options.root, "agent.env"), "utf8"),
    "concurrent owner content",
  );
  assert.deepEqual(await readdir(options.root), ["agent.env"]);
});
test("replaced parent identity cannot redirect setup writes or recursive rollback", async (t) => {
  const options = await fixture(t);
  const outside = join(options.base, "outside");
  await mkdir(outside, { mode: 0o700 });
  await mkdir(join(outside, "workspace"), { mode: 0o700 });
  await writeFile(join(outside, "workspace", "keep"), "owner data");
  await assert.rejects(
    setup(options, {
      initializeWorkspace: async (path) => {
        await mkdir(path, { mode: 0o700 });
        await rename(options.root, join(options.base, "moved"));
        await symlink(outside, options.root);
      },
    }),
    { code: "rollback" },
  );
  assert.equal(
    await readFile(join(outside, "workspace", "keep"), "utf8"),
    "owner data",
  );
  assert.deepEqual(await readdir(outside), ["workspace"]);
  assert.equal((await lstat(options.root)).isSymbolicLink(), true);
});
test("unsafe existing permissions are rejected without chmod repair", async (t) => {
  const options = await fixture(t);
  await mkdir(options.root, { mode: 0o755 });
  await chmod(options.root, 0o755);
  await assert.rejects(setup(options), { code: "permissions" });
  assert.equal((await stat(options.root)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(options.root), []);
});
test("public-checkout roots and symlink ancestors are rejected before file creation", async (t) => {
  const options = await fixture(t);
  const publicRoot = fileURLToPath(new URL("../", import.meta.url));
  await assert.rejects(
    setup({ ...options, root: join(publicRoot, "must-not-create-setup") }),
    { code: "path" },
  );
  await missing(join(publicRoot, "must-not-create-setup"));
  await symlink(options.base, join(options.base, "alias"));
  await assert.rejects(
    setup({ ...options, root: join(options.base, "alias", "new") }),
    { code: "path" },
  );
  await missing(join(options.base, "new"));
});
test("token aliases, hardlinks, permissive modes, corrupt UTF-8 and oversized/multiline inputs are rejected", async (t) => {
  for (const kind of [
    "symlink",
    "hardlink",
    "mode",
    "utf8",
    "size",
    "newline",
    "empty",
  ]) {
    const options = await fixture(t);
    if (kind === "symlink") {
      const alias = join(options.base, "alias");
      await symlink(options.tokenFile, alias);
      options.tokenFile = alias;
    }
    if (kind === "hardlink")
      await link(options.tokenFile, join(options.base, "hardlink"));
    if (kind === "mode") await chmod(options.tokenFile, 0o644);
    if (kind === "utf8")
      await writeFile(options.tokenFile, Buffer.from([0xff, 0xfe]));
    if (kind === "size") await writeFile(options.tokenFile, "x".repeat(4098));
    if (kind === "newline") await writeFile(options.tokenFile, "one\ntwo\n");
    if (kind === "empty") await writeFile(options.tokenFile, "");
    await assert.rejects(
      setup(options),
      (error) =>
        error instanceof SetupError &&
        error.code === "token" &&
        !error.message.includes(syntheticToken),
    );
    await missing(options.root);
  }
});
test("compiled configuration rejection happens before any initialization or writes", async (t) => {
  const options = await fixture(t);
  let called = false;
  await assert.rejects(
    setup(
      { ...options, ownerId: "not-an-id" },
      {
        initializeWorkspace: async () => {
          called = true;
        },
      },
    ),
    { code: "configuration" },
  );
  assert.equal(called, false);
  await missing(options.root);
});
test("CLI is deterministic noninteractively, refuses token argv and never prints raw secret/errors", async (t) => {
  const options = await fixture(t);
  for (const args of [
    ["--token", syntheticToken],
    ["--root", options.root, "--yes"],
  ]) {
    await assert.rejects(
      execute(process.execPath, [script, ...args]),
      (error) => {
        assert.equal(error.stdout.includes(syntheticToken), false);
        assert.equal(error.stderr.includes(syntheticToken), false);
        assert.match(error.stderr, /^Setup: /);
        return true;
      },
    );
  }
  const args = [
    "--yes",
    "--root",
    options.root,
    "--token-file",
    options.tokenFile,
    "--owner-id",
    options.ownerId,
    "--bot-id",
    options.botId,
    "--guild-id",
    options.guildId,
    "--forum-id",
    options.forumId,
  ];
  const { stdout, stderr } = await execute(process.execPath, [script, ...args]);
  assert.equal(stderr, "");
  assert.equal(stdout.includes(syntheticToken), false);
  assert.match(stdout, /No account was logged in/);
  assert.match(stdout, /--check-login/);
  assert.match(stdout, /--check-discord/);
  assert.match(stdout, /flock -n -E 75/);
  const loaded = await loadGenerated(join(options.root, "agent.env"));
  assert.equal(loaded.config.provider, "codex");
});
test("hidden terminal input never echoes bytes and restores raw/paused state including cancellation", async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (raw) => {
      input.isRaw = raw;
    };
    input.pause();
    let output = "";
    const pending = readHiddenToken(input, {
      write: (text) => {
        output += text;
      },
    });
    const bytes = Buffer.from("synthetic-ą-secret");
    input.write(bytes.subarray(0, 11));
    input.write(bytes.subarray(11));
    input.write(cancel ? "\u0003" : "\r");
    if (cancel) await assert.rejects(pending, { code: "cancelled" });
    else assert.equal(await pending, "synthetic-ą-secret");
    assert.equal(output.includes("secret"), false);
    assert.equal(output.includes("synthetic"), false);
    assert.equal(input.isRaw, false);
    assert.equal(input.isPaused(), true);
  }
});
test("actual terminal setup keeps the token out of its transcript and restores terminal echo", async (t) => {
  const options = await fixture(t);
  const python = `import os,pty,subprocess,select,time,termios,json,sys
master,slave=pty.openpty()
before=termios.tcgetattr(slave)
token=os.environ['SZPONT_TEST_TOKEN'].encode()
proc=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
seen=b''; sent=False; deadline=time.monotonic()+20
try:
 while proc.poll() is None:
  if time.monotonic()>deadline: raise RuntimeError('terminal setup deadline exceeded')
  ready,_,_=select.select([master],[],[],0.1)
  if ready: seen+=os.read(master,65536)
  if b'Discord bot token (hidden): ' in seen and not sent:
   os.write(master,token+b'\\r'); sent=True
 while select.select([master],[],[],0.05)[0]: seen+=os.read(master,65536)
 after=termios.tcgetattr(slave)
 mask=termios.ECHO|termios.ICANON|termios.ISIG
 print(json.dumps({'exitCode':proc.returncode,'secretInTranscript':token in seen,'prompted':sent,'completed':b'Private setup complete' in seen,'terminalRestored':(before[3]&mask)==(after[3]&mask)}))
finally:
 if proc.poll() is None: proc.kill(); proc.wait()
 os.close(master); os.close(slave)
`;
  const { stdout } = await execute(
    "python3",
    [
      "-c",
      python,
      process.execPath,
      script,
      "--yes",
      "--runner",
      "codex",
      "--root",
      options.root,
      "--owner-id",
      options.ownerId,
      "--bot-id",
      options.botId,
      "--guild-id",
      options.guildId,
      "--forum-id",
      options.forumId,
    ],
    {
      env: { ...process.env, SZPONT_TEST_TOKEN: syntheticToken },
      timeout: 25_000,
    },
  );
  assert.deepEqual(JSON.parse(stdout), {
    exitCode: 0,
    secretInTranscript: false,
    prompted: true,
    completed: true,
    terminalRestored: true,
  });
});
test("argument parsing is bounded to explicit known flags; no duplicate or inline token option", () => {
  for (const args of [
    ["--root"],
    ["--runner", "codex", "--runner", "claude"],
    ["--token=secret"],
    ["--yes", "--yes"],
    ["--token-file", "/private/token", "--token-stdin"],
  ])
    assert.throws(() => parseSetupArguments(args), { code: "arguments" });
  assert.deepEqual(
    parseSetupArguments([
      "--runner",
      "opencode",
      "--opencode-model",
      "fixture/model",
      "--allow-opencode-host-execution",
      "--yes",
    ]),
    {
      runner: "opencode",
      opencodeModel: "fixture/model",
      allowOpencodeHostExecution: true,
      yes: true,
    },
  );
});
test("explicit stdin tokens are bounded, UTF-8 checked and limited to one line", async () => {
  for (const [bytes, allowed] of [
    [Buffer.from("x".repeat(4096) + "\r\n"), true],
    [Buffer.from(syntheticToken + "\n"), true],
    [Buffer.from("x".repeat(4097)), false],
    [Buffer.from("one\ntwo"), false],
    [Buffer.from([0xff]), false],
    [Buffer.alloc(0), false],
  ]) {
    const input = new PassThrough();
    const pending = readTokenStdin(input);
    input.end(bytes);
    if (allowed)
      assert.equal(await pending, bytes.toString("utf8").replace(/\r?\n$/, ""));
    else await assert.rejects(pending, { code: "token" });
  }
});
test("CLI --token-stdin takes an explicit pipe without printing or passing token argv", async (t) => {
  const options = await fixture(t);
  const pending = execute(process.execPath, [
    script,
    "--yes",
    "--token-stdin",
    "--root",
    options.root,
    "--owner-id",
    options.ownerId,
    "--bot-id",
    options.botId,
    "--guild-id",
    options.guildId,
    "--forum-id",
    options.forumId,
  ]);
  pending.child.stdin.end(syntheticToken + "\n");
  const result = await pending;
  assert.equal((result.stdout + result.stderr).includes(syntheticToken), false);
  const loaded = await loadGenerated(join(options.root, "agent.env"));
  assert.equal(
    loaded.hash,
    createHash("sha256").update(syntheticToken).digest("hex"),
  );
});
test("container runner constraint is enforced before files and retained for config validation", async (t) => {
  const options = await fixture(t);
  const previous = process.env.SZPONT_CONTAINER_RUNNER;
  process.env.SZPONT_CONTAINER_RUNNER = "codex";
  try {
    await assert.rejects(setup({ ...options, runner: "claude" }), {
      code: "container",
    });
    await missing(options.root);
    const { loadConfig } = await import(compiledConfig);
    let marker;
    await setup(options, {
      loadConfig: (env) => {
        marker = env.SZPONT_CONTAINER_RUNNER;
        return loadConfig(env);
      },
    });
    assert.equal(marker, "codex");
    assert.equal(
      (await readFile(join(options.root, "agent.env"), "utf8")).includes(
        "SZPONT_CONTAINER_RUNNER",
      ),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.SZPONT_CONTAINER_RUNNER;
    else process.env.SZPONT_CONTAINER_RUNNER = previous;
  }
});
