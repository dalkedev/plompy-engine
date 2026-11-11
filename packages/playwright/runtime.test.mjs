import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chown,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePlaywright } from "../../scripts/integrations/playwright.mjs";
import {
  childEnvironment,
  executable,
  installation,
  privateDirectory,
  publicRoot,
} from "./runtime.mjs";
import { parseArguments } from "./launch.mjs";

async function fixture(t) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "plompy-browser-unit-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("neutral absolute launcher preserves spaces and shell syntax as single arguments", async (t) => {
  const base = await fixture(t);
  const root = join(base, "tools with ' quotes ; $(echo nope)");
  const workspace = join(base, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const result = await preparePlaywright({
    config: {
      artifactsDir: join(root, "artifacts"),
      browserDir: join(root, "browser"),
      workspace,
    },
  });
  assert.equal(result.server.command, process.execPath);
  assert.ok(result.server.args[0].endsWith("/packages/playwright/launch.mjs"));
  assert.equal(result.server.args[2], join(root, "artifacts", "playwright"));
  assert.equal(
    result.server.args[4],
    join(root, "browser", "playwright", "cache"),
  );
  assert.equal((await lstat(result.server.args[2])).mode & 0o777, 0o700);
  assert.equal((await lstat(result.server.args[4])).mode & 0o777, 0o700);
  assert.equal(result.server.env, undefined);
});
test("optional installation is pinned and runtime never invokes npx or npm", async () => {
  assert.ok((await installation()).cli.endsWith("/@playwright/mcp/cli.js"));
  const source = await readFile(
    new URL("./launch.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /"--headless",\s*"--isolated",\s*"--sandbox",\s*"--ignore-roots"/,
  );
  assert.ok(
    !source.includes('"--no-sandbox"') &&
      !source.includes('"--ignore-https-errors"'),
  );
  assert.ok(!source.includes('spawn("npx"') && !source.includes('spawn("npm"'));
});
test("existing broad directories are preserved rather than permission-repaired", async (t) => {
  const root = await fixture(t),
    directory = join(root, "broad");
  await mkdir(directory, { mode: 0o755 });
  await assert.rejects(privateDirectory(directory, { create: true }), /0700/);
  assert.equal((await lstat(directory)).mode & 0o777, 0o755);
});
test("symlink leaf and ancestor are refused without touching destination", async (t) => {
  const root = await fixture(t),
    directory = join(root, "real"),
    link = join(root, "link");
  await mkdir(directory, { mode: 0o700 });
  await symlink(directory, link);
  await writeFile(join(directory, "canary"), "preserved");
  await assert.rejects(privateDirectory(link, { create: true }), /symlinks/);
  await assert.rejects(
    privateDirectory(join(link, "child"), { create: true }),
    /symlinks/,
  );
  assert.equal(await readFile(join(directory, "canary"), "utf8"), "preserved");
});
test("public checkout, private workspace and unsafe writable parent are refused", async (t) => {
  const root = await fixture(t),
    workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  await assert.rejects(
    privateDirectory(join(publicRoot, "generated-browser"), { create: true }),
    /checkout/,
  );
  await assert.rejects(
    privateDirectory(join(workspace, "browser"), {
      create: true,
      excluded: [workspace],
    }),
    /workspace/,
  );
  const writable = join(root, "writable");
  await mkdir(writable, { mode: 0o700 });
  await chmod(writable, 0o777);
  await assert.rejects(
    privateDirectory(join(writable, "browser"), { create: true }),
    /unsafe parents/,
  );
});
test("browser overrides require absolute nonwritable regular executables", async (t) => {
  const root = await fixture(t),
    browser = join(root, "browser");
  await writeFile(browser, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(await executable(browser), browser);
  await chmod(browser, 0o777);
  await assert.rejects(executable(browser), /cannot modify/);
  await assert.rejects(executable("relative"), /absolute/);
});
test("browser executables cannot be replaced through writable or linked ancestors", async (t) => {
  const root = await fixture(t),
    directory = join(root, "bin"),
    browser = join(directory, "browser");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(browser, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(await executable(browser), browser);
  await chmod(directory, 0o777);
  await assert.rejects(executable(browser), /cannot modify/);
  assert.equal((await lstat(directory)).mode & 0o777, 0o777);
  await chmod(directory, 0o700);
  const alias = join(root, "alias");
  await symlink(directory, alias);
  await assert.rejects(executable(join(alias, "browser")), /cannot modify/);
});
test("a distinct UID cannot supply an owner-writable executable or replace its ancestor", async (t) => {
  if (process.getuid?.() !== 0)
    return t.skip(
      "Foreign-UID proof requires the disposable root-run Linux container.",
    );
  const root = await fixture(t);
  await chmod(root, 0o755);
  const foreignFile = join(root, "foreign-browser"),
    safeFile = join(root, "safe-browser"),
    foreignDirectory = join(root, "foreign-bin");
  await writeFile(foreignFile, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(safeFile, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chown(foreignFile, 1001, 1001);
  await mkdir(foreignDirectory, { mode: 0o755 });
  await writeFile(
    join(foreignDirectory, "root-browser"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 },
  );
  await chown(foreignDirectory, 1001, 1001);
  const script = `import {executable} from ${JSON.stringify(new URL("./runtime.mjs", import.meta.url).href)}; process.setgid(1000);process.setuid(1000); const results=[];for(const path of process.argv.slice(1)){try{await executable(path);results.push(true)}catch{results.push(false)}}process.stdout.write(JSON.stringify(results));`;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      foreignFile,
      join(foreignDirectory, "root-browser"),
      safeFile,
    ],
    { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH } },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [false, false, true]);
});
test("launcher rejects additional options and strips credential/injection environment", () => {
  assert.throws(() =>
    parseArguments([
      "--output-dir",
      "/private",
      "--browser-cache",
      "/cache",
      "--no-sandbox",
      "yes",
    ]),
  );
  assert.throws(() =>
    parseArguments([
      "--output-dir",
      "/private",
      "--output-dir",
      "/other",
      "--browser-cache",
      "/cache",
    ]),
  );
  const env = childEnvironment(
    {
      PATH: "/bin",
      HOME: "/private/home",
      DISCORD_TOKEN: "secret",
      PLAYWRIGHT_MCP_STORAGE_STATE: "/private/cookies",
      PLAYWRIGHT_MCP_NO_SANDBOX: "1",
      NODE_OPTIONS: "--require evil",
      DEBUG: "*",
    },
    "/cache",
    "/temporary",
  );
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/private/home",
    PLAYWRIGHT_BROWSERS_PATH: "/cache",
    PLAYWRIGHT_SKIP_BROWSER_GC: "1",
    TMPDIR: "/temporary",
    TMP: "/temporary",
    TEMP: "/temporary",
  });
});
