import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const MCP_VERSION = "0.0.85";
export const packageRoot = fileURLToPath(new URL("./", import.meta.url));
export const publicRoot = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const inside = (parent, child) =>
  child === parent || child.startsWith(parent + "/");

export function absolutePath(value) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error("Use an absolute path without control characters.");
  return resolve(value);
}

/** Refuse symlink/writable ancestors and existing nonprivate leaves; never chmod. */
export async function privateDirectory(
  value,
  { create = false, excluded = [] } = {},
) {
  const path = absolutePath(value);
  if (path === parse(path).root)
    throw new Error("Use a dedicated private directory.");
  for (const other of [publicRoot, ...excluded]) {
    const base = await realpath(other);
    if (inside(base, path) || inside(path, base))
      throw new Error(
        "Browser state must stay outside the checkout and workspace.",
      );
  }
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/")) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT" || !create)
        throw new Error("Prepare the private browser directories first.");
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      info = await lstat(current);
    }
    const own = !process.getuid || info.uid === process.getuid();
    const system = info.uid === 0;
    const stickySystemParent = current !== path && system && info.mode & 0o1000;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (!own && !system) ||
      (info.mode & 0o022 && !stickySystemParent) ||
      (current === path && (!own || info.mode & 0o077))
    )
      throw new Error(
        "Use owned 0700 browser directories without symlinks or unsafe parents.",
      );
  }
  return path;
}

export async function installation() {
  try {
    const metadataPath = require.resolve("@playwright/mcp/package.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (metadata.version !== MCP_VERSION) throw new Error("version");
    const cli = join(dirname(metadataPath), "cli.js");
    await access(cli, constants.R_OK);
    const fromMcp = createRequire(metadataPath);
    return {
      cli,
      playwright: fromMcp.resolve("playwright"),
      playwrightCli: join(
        dirname(fromMcp.resolve("playwright/package.json")),
        "cli.js",
      ),
    };
  } catch {
    throw new Error(
      "Install the pinned optional tools first: npm ci --prefix packages/playwright.",
    );
  }
}

export async function executable(value) {
  const path = absolutePath(value);
  try {
    const uid = process.getuid?.();
    const trusted = (info) => info.uid === 0 || info.uid === uid;
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      !trusted(info) ||
      info.mode & 0o022
    )
      throw new Error();
    // An immutable leaf is insufficient when another user can replace a parent
    // directory. Root-owned sticky temporary parents protect trusted children;
    // all other ancestors must be root/current-user owned and nonwritable to peers.
    let parent = dirname(path);
    for (;;) {
      const ancestor = await lstat(parent);
      const stickySystemParent = ancestor.uid === 0 && ancestor.mode & 0o1000;
      if (
        !ancestor.isDirectory() ||
        ancestor.isSymbolicLink() ||
        !trusted(ancestor) ||
        (ancestor.mode & 0o022 && !stickySystemParent)
      )
        throw new Error();
      if (parent === parse(parent).root) break;
      parent = dirname(parent);
    }
    await access(path, constants.X_OK);
    return path;
  } catch {
    throw new Error(
      "Use a regular browser executable and trusted ancestors that other users cannot modify.",
    );
  }
}

export function childEnvironment(env, cache, temporary) {
  const clean = Object.fromEntries(
    ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "SystemRoot"]
      .filter((key) => typeof env[key] === "string")
      .map((key) => [key, env[key]]),
  );
  return {
    ...clean,
    PLAYWRIGHT_BROWSERS_PATH: cache,
    PLAYWRIGHT_SKIP_BROWSER_GC: "1",
    ...(temporary
      ? { TMPDIR: temporary, TMP: temporary, TEMP: temporary }
      : {}),
  };
}
