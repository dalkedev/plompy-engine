import { mkdir, realpath, copyFile, chmod } from "node:fs/promises";
import { resolve, dirname, join, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const within = (path) => path === root || path.startsWith(root + sep);
async function canonicalDestination(path) {
  const missing = [];
  let ancestor = path;
  while (true) {
    try {
      return join(await realpath(ancestor), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}
try {
  const [input, extra] = process.argv.slice(2);
  if (!input || extra || !isAbsolute(input) || resolve(input) === "/")
    throw new Error(
      "Usage: node scripts/init-workspace.mjs /absolute/private/workspace",
    );
  const target = await canonicalDestination(resolve(input));
  if (within(target))
    throw new Error("Refusing private state inside the public source checkout");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(target));
  if (within(parent))
    throw new Error("Refusing a symlink alias into the public source checkout");
  const destination = join(parent, relative(dirname(target), target));
  await mkdir(destination, { mode: 0o700 }); // Exclusive: never replace an existing workspace.
  for (const directory of [
    "agent",
    "agent/memory",
    "agent/conversations",
    "agent/journal",
  ])
    await mkdir(join(destination, directory), { mode: 0o700 });
  for (const file of [
    "AGENTS.md",
    ".gitignore",
    "agent/SOUL.md",
    "agent/USER.md",
    "agent/MEMORY.md",
    "agent/POLICY.md",
  ]) {
    const output = join(destination, file);
    await copyFile(join(root, "examples/workspace", file), output);
    await chmod(output, 0o600);
  }
  await exec("git", ["init", "-b", "memory"], { cwd: destination });
  await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "add",
      "AGENTS.md",
      ".gitignore",
      "agent",
    ],
    { cwd: destination },
  );
  await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Plompy",
      "-c",
      "user.email=plompy@localhost",
      "commit",
      "-m",
      "Initialize private workspace",
    ],
    { cwd: destination },
  );
  console.log("Private workspace initialized: " + destination);
} catch (error) {
  console.error(
    "Workspace initialization failed: " +
      (error.code === "EEXIST"
        ? "destination already exists; existing files were preserved"
        : error.message),
  );
  process.exitCode = 1;
}
