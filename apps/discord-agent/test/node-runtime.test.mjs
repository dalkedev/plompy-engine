import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  inspectRuntime,
  assertSupportedRuntime,
} from "../dist/node-runtime.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));

test("actual Node and linked SQLite pass a real in-memory version query", () => {
  const actual = inspectRuntime();
  assert.equal(actual.node.status, "PASS");
  assert.equal(actual.sqlite.status, "PASS");
  assert.match(
    actual.sqlite.message,
    /runtime metadata and an in-memory SQL query/,
  );
  assert.doesNotThrow(() => assertSupportedRuntime());
});

test("the Node floor rejects older majors, old Node 26, unstable versions and Node 27 before querying SQLite", () => {
  for (const nodeVersion of [
    "24.22.2",
    "25.9.0",
    "26.0.0",
    "26.12.99",
    "27.0.0",
    "26.13.0-rc.1",
    "26.013.0",
    "v26.13.0",
    "invalid",
    "26.13.9007199254740992",
  ]) {
    let queried = false;
    const result = inspectRuntime({
      nodeVersion,
      sqliteVersion: "3.54.0",
      querySQLiteVersion: () => {
        queried = true;
        return "3.54.0";
      },
    });
    assert.equal(result.node.status, "FAIL");
    assert.equal(result.sqlite.status, "NOT_RUN");
    assert.equal(queried, false);
  }
  for (const nodeVersion of ["26.13.0", "26.13.1", "26.14.0"]) {
    const result = inspectRuntime({
      nodeVersion,
      sqliteVersion: "3.54.0",
      querySQLiteVersion: () => "3.54.0",
    });
    assert.equal(result.node.status, "PASS");
    assert.equal(result.sqlite.status, "PASS");
  }
});

test("old or malformed SQLite metadata cannot claim backport support or trigger a database probe", () => {
  for (const sqliteVersion of [
    "3.53.4",
    "3.51.1",
    "3.54.0-backport",
    "3.054.0",
    "invalid",
    "",
    "3.54.9007199254740992",
  ]) {
    let queried = false;
    const result = inspectRuntime({
      nodeVersion: "26.13.0",
      sqliteVersion,
      querySQLiteVersion: () => {
        queried = true;
        return "3.54.0";
      },
    });
    assert.equal(result.sqlite.status, "FAIL");
    assert.equal(queried, false);
  }
});

test("metadata alone is insufficient: older, mismatched, unavailable or malformed actual SQLite fails closed", () => {
  const secret = "synthetic-unprintable-runtime-diagnostic";
  for (const linked of [
    "3.53.4",
    "3.54.1",
    undefined,
    { secret },
    new Error(secret),
  ]) {
    const result = inspectRuntime({
      nodeVersion: "26.13.0",
      sqliteVersion: "3.54.0",
      querySQLiteVersion: () => {
        if (linked instanceof Error) throw linked;
        return linked;
      },
    });
    assert.equal(result.sqlite.status, "FAIL");
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("Store rejects unsupported runtimes before creating or interpreting a filesystem database", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "szpont-runtime-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const existing = join(temporary, "existing.sqlite");
  const fresh = join(temporary, "must-not-create.sqlite");
  const canary =
    "Synthetic existing bytes must never reach SQLite on an unsupported runtime.";
  await writeFile(existing, canary);
  const code = `
    import assert from 'node:assert/strict';
    const [storeFile, field, value, existing, fresh, expected] = process.argv.slice(1);
    Object.defineProperty(process.versions, field, {value});
    const {Store}=await import(storeFile);
    for(const path of [existing,fresh]) assert.throws(()=>new Store(path),new RegExp(expected));
    console.log('PASS rejected before filesystem database open');
  `;
  for (const [field, value, expected] of [
    ["node", "24.22.2", "unsupported_node_runtime"],
    ["node", "26.12.9", "unsupported_node_runtime"],
    ["sqlite", "3.53.4", "unsupported_sqlite_runtime"],
  ]) {
    const result = await execute(process.execPath, [
      "--input-type=module",
      "-e",
      code,
      fileURLToPath(new URL("../dist/store.js", import.meta.url)),
      field,
      value,
      existing,
      fresh,
      expected,
    ]);
    assert.match(result.stdout, /PASS rejected/);
    assert.equal(await readFile(existing, "utf8"), canary);
    assert.deepEqual(await readdir(temporary), ["existing.sqlite"]);
  }
});

test("setup and snapshot reject unsupported runtime metadata before creating deployment or snapshot files", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "szpont-runtime-tools-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const code = `
    import assert from 'node:assert/strict';
    const [sourceRoot,field,value,temporary]=process.argv.slice(1);
    Object.defineProperty(process.versions,field,{value});
    const {setup}=await import(sourceRoot+'/scripts/setup.mjs');
    await assert.rejects(setup({root:temporary+'/new-private'}),{code:'node'});
    const {snapshotState}=await import(sourceRoot+'/scripts/state-snapshot.mjs');
    await assert.rejects(snapshotState({operation:'backup',source:temporary+'/absent.sqlite',destination:temporary+'/snapshot.sqlite'}),/supported_runtime_required/);
    console.log('PASS tools rejected before filesystem writes');
  `;
  for (const [field, value] of [
    ["node", "24.22.2"],
    ["sqlite", "3.53.4"],
  ]) {
    const result = await execute(process.execPath, [
      "--input-type=module",
      "-e",
      code,
      root,
      field,
      value,
      temporary,
    ]);
    assert.match(result.stdout, /PASS tools rejected/);
    assert.deepEqual(await readdir(temporary), []);
  }
});

test("engine entrypoint rejects the unsupported runtime before preparing private state directories", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "szpont-runtime-entry-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(join(temporary, "workspace"));
  const code = `
    import {Socket} from 'node:net';
    // A regression must never turn this negative startup probe into network IO.
    Socket.prototype.connect=function(){throw new Error('network disabled in runtime test')};
    Object.defineProperty(process.versions,'node',{value:'24.22.2'});
    await import(process.argv[1]);
  `;
  await assert.rejects(
    execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        code,
        fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      ],
      {
        env: {
          PATH: process.env.PATH,
          DISCORD_BOT_TOKEN: "synthetic-runtime-test-token",
          SZPONT_DISCORD_GUILD_ID: "111111111111111111",
          SZPONT_DISCORD_OWNER_ID: "222222222222222222",
          SZPONT_DISCORD_BOT_ID: "333333333333333333",
          SZPONT_DISCORD_PARENT_CHANNEL_ID: "444444444444444444",
          SZPONT_WORKSPACE: join(temporary, "workspace"),
          SZPONT_STATE_DIR: join(temporary, "state"),
          SZPONT_ARTIFACTS_DIR: join(temporary, "artifacts"),
          SZPONT_BROWSER_DIR: join(temporary, "browser"),
          CODEX_HOME: join(temporary, "codex"),
        },
        timeout: 5_000,
      },
    ),
    (error) => error.code === 1 && error.stderr.includes('"event":"startup"'),
  );
  assert.deepEqual(await readdir(temporary), ["workspace"]);
});
