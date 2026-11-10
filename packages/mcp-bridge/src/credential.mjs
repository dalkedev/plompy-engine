import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const message =
  "Use a separate owner-only credential file (0600, private 0700 parent, no links, at most 4096 token bytes) outside source, workspace, state and runner directories.";
const within = (a, b) => {
  const p = relative(a, b);
  return (
    p === "" || (!isAbsolute(p) && p !== ".." && !p.startsWith(`..${sep}`))
  );
};

async function canonicalBoundary(path) {
  let current = resolve(path);
  const missing = [];
  for (;;) {
    try {
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(relative(parent, current));
      current = parent;
    }
  }
}

// Secrets are read only through this bounded handle. Never return native errors,
// file contents or paths in a diagnostic, and never modify an operator's file.
export async function readCredential(path, { excluded = [] } = {}) {
  let handle;
  try {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      resolve(path) === sep ||
      /[\x00-\x1f\x7f]/.test(path)
    )
      throw new Error();
    const target = resolve(path);
    // Reject aliases in every component, including a symlinked parent.
    let component = target;
    while (component !== parse(component).root) {
      if ((await lstat(component)).isSymbolicLink()) throw new Error();
      component = dirname(component);
    }
    const canonical = await realpath(target);
    for (const boundary of [sourceRoot, ...excluded].filter(Boolean)) {
      const other = await canonicalBoundary(boundary);
      if (within(other, canonical) || within(canonical, other))
        throw new Error();
    }
    const parent = await lstat(dirname(target));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.mode & 0o077 ||
      (process.getuid && parent.uid !== process.getuid())
    )
      throw new Error();
    handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat(),
      link = await lstat(target);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 4098 ||
      before.mode & 0o077 ||
      (process.getuid && before.uid !== process.getuid()) ||
      link.isSymbolicLink() ||
      before.dev !== link.dev ||
      before.ino !== link.ino
    )
      throw new Error();
    const buffer = Buffer.alloc(4099);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat(),
      current = await lstat(target);
    if (
      length > 4098 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      current.isSymbolicLink() ||
      (await realpath(target)) !== canonical
    )
      throw new Error();
    let token;
    try {
      token = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } finally {
      buffer.fill(0);
    }
    token = token.replace(/\r?\n$/, "");
    // HTTP header values must be printable ASCII. Spaces are rejected so a file
    // cannot accidentally contain a whole header, multiple tokens or a command.
    if (
      !token ||
      Buffer.byteLength(token) > 4096 ||
      !/^[\x21-\x7e]+$/.test(token)
    )
      throw new Error();
    return { path: canonical, token };
  } catch {
    throw new Error(message);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function inspectCredential(path, options) {
  return (await readCredential(path, options)).path;
}
