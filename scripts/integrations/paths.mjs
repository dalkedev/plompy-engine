import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const inside = (parent, child) =>
  child === parent || child.startsWith(parent + sep);

export async function canonical(path) {
  let ancestor = resolve(path);
  const missing = [];
  for (;;) {
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

export async function privatePath(path, publicRoot, excluded = []) {
  if (
    !path ||
    !isAbsolute(path) ||
    /[\x00-\x1f\x7f]/.test(path) ||
    resolve(path) === "/"
  )
    throw new Error(
      "Use an absolute private path outside the public checkout.",
    );
  const target = await canonical(path);
  for (const other of [publicRoot, ...excluded]) {
    const base = await canonical(other);
    if (inside(base, target) || inside(target, base))
      throw new Error(
        "Private integration paths must not overlap the public checkout or workspace.",
      );
  }
  return target;
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(
      "Integration directories must be owned by the service user with mode 0700.",
    );
}

export async function readPrivateJson(path, fallback) {
  let file;
  try {
    file = await open(path, "r");
    const info = await file.stat(),
      link = await lstat(path);
    if (
      !info.isFile() ||
      link.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 65_536 ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Use an owner-only regular JSON file (0600, at most 64 KiB).",
      );
    return JSON.parse(await file.readFile("utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw new Error(
      "Private integration JSON is missing, unsafe or invalid; existing files were preserved.",
    );
  } finally {
    await file?.close();
  }
}

export async function writePrivate(path, text) {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Refusing to replace an unsafe integration file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(text, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await rm(temporary, { force: true });
  }
}
