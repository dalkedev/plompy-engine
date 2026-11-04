import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatReport, runDoctor } from "./doctor.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/doctor.mjs");
const secret = "synthetic-private-token-DO-NOT-DISCLOSE";
const requiredKeys = [
  "SZPONT_WORKSPACE",
  "SZPONT_STATE_DIR",
  "SZPONT_ARTIFACTS_DIR",
  "CODEX_HOME",
  "SZPONT_BROWSER_DIR",
];
const resultFor = (result, id) =>
  result.checks.find((check) => check.id === id);

async function fixture(
  t,
  { version = "codex-cli 0.166.0", loginCode = 0 } = {},
) {
  const temporary = await mkdtemp(join(tmpdir(), "szpont-doctor-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const publicRoot = join(temporary, "public-source");
  await mkdir(publicRoot);
  const paths = ["workspace", "state", "artifacts", "codex", "browser"].map(
    (part) => join(temporary, "private", part),
  );
  await Promise.all(
    paths.map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await execute("git", ["init", "--quiet"], {
    cwd: paths[0],
    env: {
      PATH: process.env.PATH,
      HOME: temporary,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const marker = join(temporary, "login-was-called");
  const binary = join(temporary, "fake-codex.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.env.DISCORD_BOT_TOKEN || process.env.GIT_DIR || process.env.UNRELATED_SECRET) {
  console.error(${JSON.stringify(secret)}); process.exit(91);
}
if (process.argv.slice(2).join(' ') === '--version') {
  console.log(${JSON.stringify(version)});
} else if (process.argv.slice(2).join(' ') === 'login status') {
  writeFileSync(${JSON.stringify(marker)}, 'explicit login check');
  console.log(${JSON.stringify(secret)});
  console.error(${JSON.stringify(temporary)});
  process.exit(${loginCode});
} else process.exit(92);
`,
    { mode: 0o700 },
  );
  const env = {
    PATH: process.env.PATH,
    HOME: temporary,
    DISCORD_BOT_TOKEN: secret,
    SZPONT_DISCORD_GUILD_ID: "111111111111111111",
    SZPONT_DISCORD_OWNER_ID: "222222222222222222",
    SZPONT_DISCORD_BOT_ID: "333333333333333333",
    SZPONT_DISCORD_PARENT_CHANNEL_ID: "444444444444444444",
    SZPONT_CODEX_BIN: binary,
    UNRELATED_SECRET: secret,
    GIT_DIR: join(publicRoot, "injected.git"),
    ...Object.fromEntries(
      requiredKeys.map((key, index) => [key, paths[index]]),
    ),
  };
  return {
    temporary,
    publicRoot,
    env,
    marker,
    inspect: (options = {}) => runDoctor({ env, publicRoot, ...options }),
  };
}

async function snapshot(path) {
  const value = await stat(path);
  if (!value.isDirectory())
    return [
      value.mode,
      value.size,
      value.mtimeMs,
      (await readFile(path)).toString("base64"),
    ];
  return [
    value.mode,
    value.mtimeMs,
    await Promise.all(
      (await readdir(path))
        .sort()
        .map(async (entry) => [entry, await snapshot(join(path, entry))]),
    ),
  ];
}

function assertPrivateOutput(result, data) {
  for (const output of [formatReport(result), formatReport(result, true)]) {
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes(data.temporary), false);
    assert.equal(output.includes(data.env.SZPONT_CODEX_BIN), false);
  }
}

test("healthy offline inspection passes, omits login and leaves deployment bytes, modes and modification times unchanged", async (t) => {
  const data = await fixture(t);
  const before = await snapshot(data.temporary);
  const result = await data.inspect();
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks.map(({ id, status }) => [id, status]),
    [
      ["node_runtime", "PASS"],
      ["configuration", "PASS"],
      ["path_separation", "PASS"],
      ["private_directories", "PASS"],
      ["private_writability", "PASS"],
      ["workspace_git", "PASS"],
      ["codex_version", "PASS"],
      ["codex_login", "NOT_RUN"],
    ],
  );
  assert.deepEqual(await snapshot(data.temporary), before);
  assertPrivateOutput(result, data);
});

test("Node versions outside 24 are required failures", async (t) => {
  const data = await fixture(t);
  const result = await data.inspect({ nodeVersion: "22.15.0" });
  assert.equal(result.ok, false);
  assert.equal(resultFor(result, "node_runtime").status, "FAIL");
});

test("the compiled loader rejects missing identities without exposing values or invoking Codex", async (t) => {
  const data = await fixture(t);
  delete data.env.SZPONT_DISCORD_OWNER_ID;
  const result = await data.inspect({ checkLogin: true });
  assert.equal(result.ok, false);
  assert.equal(resultFor(result, "configuration").status, "FAIL");
  assert.equal(resultFor(result, "codex_version").status, "NOT_RUN");
  assert.equal(resultFor(result, "codex_login").status, "NOT_RUN");
  await assert.rejects(stat(data.marker), { code: "ENOENT" });
  assertPrivateOutput(result, data);
});

test("configuration validation retains the loader's identity and timeout constraints", async (t) => {
  const data = await fixture(t);
  for (const patch of [
    { SZPONT_DISCORD_GUILD_ID: "invalid" },
    { SZPONT_TASK_TIMEOUT_MS: "0" },
    { SZPONT_WORKSPACE: "relative-workspace" },
  ]) {
    const result = await runDoctor({
      env: { ...data.env, ...patch },
      publicRoot: data.publicRoot,
    });
    assert.equal(resultFor(result, "configuration").status, "FAIL");
    assert.equal(result.ok, false);
  }
});

test("missing private directories fail without creating directories, an SQLite database or auth files", async (t) => {
  const data = await fixture(t);
  const missing = join(data.temporary, "not-created", "state");
  data.env.SZPONT_STATE_DIR = missing;
  const before = await snapshot(data.temporary);
  const result = await data.inspect();
  assert.equal(resultFor(result, "path_separation").status, "PASS");
  assert.equal(resultFor(result, "private_directories").status, "FAIL");
  assert.equal(resultFor(result, "workspace_git").status, "NOT_RUN");
  assert.equal(result.ok, false);
  assert.deepEqual(await snapshot(data.temporary), before);
  await assert.rejects(stat(dirname(missing)), { code: "ENOENT" });
});

test("a file cannot masquerade as a private directory", async (t) => {
  const data = await fixture(t);
  const file = join(data.temporary, "not-a-directory");
  await writeFile(file, "synthetic");
  data.env.SZPONT_ARTIFACTS_DIR = file;
  const result = await data.inspect();
  assert.equal(resultFor(result, "private_directories").status, "FAIL");
  assert.equal(result.ok, false);
});

test("symlink aliases into public source are rejected even when the final destination is missing", async (t) => {
  const data = await fixture(t);
  const alias = join(data.temporary, "public-alias");
  await symlink(data.publicRoot, alias, "dir");
  data.env.CODEX_HOME = join(alias, "missing-private-home");
  const result = await data.inspect();
  assert.equal(resultFor(result, "path_separation").status, "FAIL");
  assert.equal(resultFor(result, "codex_version").status, "NOT_RUN");
  assertPrivateOutput(result, data);
});

test("public root aliases and private ancestors of source cannot bypass separation", async (t) => {
  const data = await fixture(t);
  const alias = join(data.temporary, "source-alias");
  await symlink(data.publicRoot, alias, "dir");
  data.env.SZPONT_BROWSER_DIR = data.temporary;
  const result = await data.inspect({ publicRoot: alias });
  assert.equal(resultFor(result, "path_separation").status, "FAIL");
});

test("overlapping private directories and relative browser paths are rejected", async (t) => {
  const data = await fixture(t);
  for (const value of [
    data.env.SZPONT_WORKSPACE,
    join(data.env.SZPONT_WORKSPACE, "state"),
  ]) {
    data.env.SZPONT_STATE_DIR = value;
    assert.equal(
      resultFor(await data.inspect(), "path_separation").status,
      "FAIL",
    );
  }
  data.env.SZPONT_STATE_DIR = join(data.temporary, "private", "state");
  data.env.SZPONT_BROWSER_DIR = "relative-browser";
  assert.equal(
    resultFor(await data.inspect(), "path_separation").status,
    "FAIL",
  );
});

test("different private directory names resolving to the same target are rejected", async (t) => {
  const data = await fixture(t);
  const alias = join(data.temporary, "state-alias");
  await symlink(data.env.SZPONT_STATE_DIR, alias, "dir");
  data.env.SZPONT_ARTIFACTS_DIR = alias;
  assert.equal(
    resultFor(await data.inspect(), "path_separation").status,
    "FAIL",
  );
});

test(
  "a read-only private directory fails the permission inspection without chmod or write probes",
  {
    skip:
      process.getuid?.() === 0 &&
      "root can bypass mode-based write permissions",
  },
  async (t) => {
    const data = await fixture(t);
    await chmod(data.env.SZPONT_STATE_DIR, 0o500);
    t.after(() => chmod(data.env.SZPONT_STATE_DIR, 0o700).catch(() => {}));
    const before = await stat(data.env.SZPONT_STATE_DIR);
    const result = await data.inspect();
    assert.equal(resultFor(result, "private_writability").status, "FAIL");
    assert.equal(result.ok, false);
    const after = await stat(data.env.SZPONT_STATE_DIR);
    assert.equal(after.mode, before.mode);
    assert.equal(after.mtimeMs, before.mtimeMs);
  },
);

test("an inherited parent Git repository is not accepted as an initialized workspace", async (t) => {
  const data = await fixture(t);
  const nested = join(data.env.SZPONT_WORKSPACE, "nested");
  await mkdir(nested);
  data.env.SZPONT_WORKSPACE = nested;
  assert.equal(resultFor(await data.inspect(), "workspace_git").status, "FAIL");
});

test("Git metadata cannot be a symlink back into public source", async (t) => {
  const data = await fixture(t);
  const metadata = join(data.env.SZPONT_WORKSPACE, ".git");
  const publicMetadata = join(data.publicRoot, "public.git");
  const { rename } = await import("node:fs/promises");
  await rename(metadata, publicMetadata);
  await symlink(publicMetadata, metadata, "dir");
  const result = await data.inspect();
  assert.equal(resultFor(result, "workspace_git").status, "FAIL");
  assertPrivateOutput(result, data);
});

test("a mismatched or unexpected CLI response fails without echoing stdout or stderr", async (t) => {
  for (const version of [
    "codex-cli 0.165.0",
    `${secret} /private/synthetic/account`,
  ]) {
    const data = await fixture(t, { version });
    const result = await data.inspect({ checkLogin: true });
    assert.equal(resultFor(result, "codex_version").status, "FAIL");
    assert.equal(resultFor(result, "codex_login").status, "NOT_RUN");
    assert.equal(result.ok, false);
    assertPrivateOutput(result, data);
    await assert.rejects(stat(data.marker), { code: "ENOENT" });
  }
});

test("an unavailable Codex executable produces a fixed failure rather than raw process errors", async (t) => {
  const data = await fixture(t);
  data.env.SZPONT_CODEX_BIN = join(data.temporary, secret);
  const result = await data.inspect();
  assert.equal(resultFor(result, "codex_version").status, "FAIL");
  assert.equal(result.ok, false);
  assertPrivateOutput(result, data);
});

test("login status runs only after explicit opt-in and consumes no unfiltered parent secrets", async (t) => {
  const data = await fixture(t);
  const result = await data.inspect({ checkLogin: true });
  assert.equal(resultFor(result, "codex_login").status, "PASS");
  assert.equal(result.ok, true);
  assert.equal(await readFile(data.marker, "utf8"), "explicit login check");
  assertPrivateOutput(result, data);
});

test("an explicitly requested login failure is required and its output remains private", async (t) => {
  const data = await fixture(t, { loginCode: 1 });
  const result = await data.inspect({ checkLogin: true });
  assert.equal(resultFor(result, "codex_login").status, "FAIL");
  assert.equal(resultFor(result, "codex_login").required, true);
  assert.equal(result.ok, false);
  assertPrivateOutput(result, data);
});

test("CLI JSON is parseable, uses the real compiled loader and exits nonzero for required failures", async (t) => {
  const data = await fixture(t);
  const healthy = await execute(process.execPath, [script, "--json"], {
    env: data.env,
  });
  const result = JSON.parse(healthy.stdout);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, true);
  assert.equal(healthy.stderr, "");
  assertPrivateOutput(result, data);
  delete data.env.DISCORD_BOT_TOKEN;
  await assert.rejects(
    execute(process.execPath, [script, "--json"], { env: data.env }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).ok, false);
      assert.equal(error.stderr, "");
      return true;
    },
  );
});

test("an unbuilt checkout produces a fixed configuration failure without loading source or creating dist", async (t) => {
  const data = await fixture(t);
  const copied = join(data.publicRoot, "scripts", "doctor.mjs");
  await mkdir(dirname(copied));
  await copyFile(script, copied);
  await assert.rejects(
    execute(process.execPath, [copied, "--json"], { env: data.env }),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(resultFor(result, "configuration").status, "FAIL");
      assertPrivateOutput(result, data);
      return true;
    },
  );
  await assert.rejects(stat(resolve(dirname(copied), "../apps")), {
    code: "ENOENT",
  });
});

test("invalid flags are rejected without echoing untrusted argument values", async () => {
  await assert.rejects(
    execute(process.execPath, [script, "--json", secret]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).checks[0].id, "arguments");
      assert.equal(error.stdout.includes(secret), false);
      assert.equal(error.stderr, "");
      return true;
    },
  );
});
