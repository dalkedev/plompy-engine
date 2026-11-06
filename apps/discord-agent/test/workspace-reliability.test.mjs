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
import { join, delimiter } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncMemory } from "../dist/workspace.js";

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "szpont-memory-retry-"));
  const workspace = join(root, "workspace");
  for (const path of ["agent/memory", "agent/journal", "agent/conversations"])
    await mkdir(join(workspace, path), { recursive: true });
  for (const path of ["agent/MEMORY.md", "agent/SOUL.md", "agent/USER.md"])
    await writeFile(join(workspace, path), "Initial memory\n");
  await writeFile(join(workspace, "operator.txt"), "Initial operator work\n");
  const originalPath = process.env.PATH;
  const git = async (args) =>
    (
      await exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          ...args,
        ],
        {
          cwd: workspace,
          env: { ...process.env, PATH: originalPath },
        },
      )
    ).stdout;
  await git(["init", "--initial-branch=memory"]);
  await git(["add", "--all"]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Baseline",
  ]);
  const config = {
    workspace,
    stateDir: join(root, "state"),
    token: "synthetic-token",
    codexHome: join(root, "codex"),
    artifactsDir: join(root, "artifacts"),
    browserDir: join(root, "browser"),
  };
  const intercept = async (beforeCommit) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    const script = join(bin, "git");
    await writeFile(
      script,
      `#!${process.execPath}\n` +
        `const {spawnSync}=require("node:child_process");\n` +
        `const {existsSync,writeFileSync}=require("node:fs");\n` +
        `const args=process.argv.slice(2), marker=${JSON.stringify(join(root, "intercepted"))};\n` +
        `const originalEnv={...process.env,PATH:${JSON.stringify(originalPath)}};\n` +
        `if(args.includes("commit")&&!existsSync(marker)){writeFileSync(marker,"once");${beforeCommit}}\n` +
        `const child=spawnSync("git",args,{stdio:"inherit",env:originalEnv});process.exit(child.status??1);\n`,
    );
    await chmod(script, 0o700);
    process.env.PATH = `${bin}${delimiter}${originalPath}`;
  };
  return {
    root,
    workspace,
    config,
    git,
    intercept,
    close: async () => {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const scenario of [
  { name: "tracked modification", path: "agent/MEMORY.md" },
  { name: "personality", path: "agent/SOUL.md" },
  { name: "preferences", path: "agent/USER.md" },
  { name: "new memory", path: "agent/memory/new-note.md" },
  { name: "new journal", path: "agent/journal/new-entry.md" },
  {
    name: "new conversation",
    path: "agent/conversations/1567000000000000001.md",
  },
  { name: "tracked deletion", deleted: "agent/MEMORY.md" },
  {
    name: "memory rename",
    path: "agent/memory/renamed.md",
    deleted: "agent/MEMORY.md",
  },
])
  test(
    `a transient commit failure heals without staging memory content: ${scenario.name}`,
    { skip: process.platform === "win32" },
    async () => {
      const f = await fixture();
      try {
        const before = (await f.git(["rev-parse", "HEAD"])).trim();
        if (scenario.deleted) await rm(join(f.workspace, scenario.deleted));
        if (scenario.path)
          await writeFile(join(f.workspace, scenario.path), "Updated memory\n");
        await f.intercept(
          'process.stderr.write("Synthetic transient commit failure\\n");process.exit(42);',
        );
        await assert.rejects(syncMemory(f.config, "1567000000000001001"));
        assert.equal((await f.git(["rev-parse", "HEAD"])).trim(), before);
        assert.equal(await f.git(["diff", "--cached", "--name-only"]), "");
        if (scenario.path)
          assert.equal(
            await readFile(join(f.workspace, scenario.path), "utf8"),
            "Updated memory\n",
          );
        assert.equal(
          await syncMemory(f.config, "1567000000000001001"),
          "committed",
        );
        if (scenario.path)
          assert.equal(
            await f.git(["show", `HEAD:${scenario.path}`]),
            "Updated memory\n",
          );
        if (scenario.deleted)
          assert.equal(
            await f.git([
              "ls-tree",
              "--name-only",
              "HEAD",
              "--",
              scenario.deleted,
            ]),
            "",
          );
        assert.equal(await f.git(["diff", "--cached", "--name-only"]), "");
        const committed = (await f.git(["rev-parse", "HEAD"])).trim();
        assert.notEqual(committed, before);
        assert.equal(
          await syncMemory(f.config, "1567000000000001001"),
          "clean",
        );
        assert.equal((await f.git(["rev-parse", "HEAD"])).trim(), committed);
      } finally {
        await f.close();
      }
    },
  );

test("pre-existing operator staging is blocked and preserved byte for byte", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.workspace, "operator.txt"),
      "Staged operator work\n",
    );
    await f.git(["add", "operator.txt"]);
    await writeFile(
      join(f.workspace, "operator.txt"),
      "Later unstaged operator work\n",
    );
    await writeFile(join(f.workspace, "agent/MEMORY.md"), "Updated memory\n");
    const staged = await f.git(["diff", "--cached", "--binary"]);
    const head = await f.git(["rev-parse", "HEAD"]);
    assert.equal(await syncMemory(f.config, "1567000000000001002"), "blocked");
    assert.equal(await f.git(["diff", "--cached", "--binary"]), staged);
    assert.equal(await f.git(["rev-parse", "HEAD"]), head);
    assert.equal(
      await readFile(join(f.workspace, "operator.txt"), "utf8"),
      "Later unstaged operator work\n",
    );
  } finally {
    await f.close();
  }
});

test(
  "operator staging arriving after the guard survives a memory-only commit",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.workspace, "agent/MEMORY.md"), "Updated memory\n");
      await f.intercept(
        `writeFileSync("operator.txt","Concurrent staged operator work\\n");` +
          `const staged=spawnSync("git",["add","operator.txt"],{env:originalEnv,stdio:"inherit"});` +
          `if(staged.status!==0)process.exit(43);` +
          `writeFileSync("operator.txt","Concurrent unstaged operator work\\n");`,
      );
      assert.equal(
        await syncMemory(f.config, "1567000000000001003"),
        "committed",
      );
      assert.equal(
        await f.git(["show", "HEAD:agent/MEMORY.md"]),
        "Updated memory\n",
      );
      assert.equal(
        await f.git(["show", "HEAD:operator.txt"]),
        "Initial operator work\n",
      );
      assert.equal(
        await f.git(["show", ":operator.txt"]),
        "Concurrent staged operator work\n",
      );
      assert.equal(
        await readFile(join(f.workspace, "operator.txt"), "utf8"),
        "Concurrent unstaged operator work\n",
      );
      assert.equal(
        (await f.git(["diff", "--cached", "--name-only"])).trim(),
        "operator.txt",
      );
    } finally {
      await f.close();
    }
  },
);
