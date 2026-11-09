import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  realpath,
  open,
  readlink,
  mkdtemp,
  writeFile,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

export const REPOSITORY_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const REPOSITORY_EVIDENCE_MAX_BYTES = 256 * 1024;
export const REPOSITORY_PATCH_MAX_BYTES = 96 * 1024;
export const REPOSITORY_MAX_FILES = 1024;
export const REPOSITORY_FILE_MAX_BYTES = 512 * 1024;
const CAPTURE_BYTES = 3 * 1024 * 1024;
const PATH_BYTES = 4096;
const NOTE =
  "Engine-observed before/after working-tree changes; not proof of authorship or test success. Omitted content is not evidence of no change.";
export type RepositoryFileKind =
  | "text"
  | "binary"
  | "symlink"
  | "omitted"
  | "missing";
export interface RepositoryFileMetadata {
  kind: RepositoryFileKind;
  size: number;
  mode: number;
  sha256?: string;
  target?: string;
}
export interface RepositoryFile extends RepositoryFileMetadata {
  path: string;
  text?: string;
  reason?: string;
}
export interface RepositoryOmission {
  path: string;
  reason: string;
}
export interface RepositorySnapshot {
  version: 1;
  root: string;
  head: string | null;
  capturedAt: string;
  files: RepositoryFile[];
  complete: boolean;
  omissions: RepositoryOmission[];
  contentHash: string;
}
export interface RepositoryChange {
  path: string;
  kind: "added" | "deleted" | "modified" | "type_changed" | "mode_changed";
  before: RepositoryFileMetadata | null;
  after: RepositoryFileMetadata | null;
}
export interface RepositoryDiffEvidence {
  version: 1;
  root: string;
  status: "complete" | "partial" | "unavailable";
  beforeHash: string | null;
  afterHash: string | null;
  beforeHead: string | null;
  afterHead: string | null;
  changes: RepositoryChange[];
  patch: string;
  omissions: RepositoryOmission[];
  note: string;
  error?: string;
}
export interface CaptureRepositoryOptions {
  /** Previously authorized canonical root; compare before any Git or file read. */
  expectedRoot?: string;
  previousPaths?: readonly string[];
  signal?: AbortSignal;
}
export interface CompareRepositoryOptions {
  temporaryDirectory?: string;
  signal?: AbortSignal;
}
const kinds = new Set(["text", "binary", "symlink", "omitted", "missing"]);
const changes = new Set([
  "added",
  "deleted",
  "modified",
  "type_changed",
  "mode_changed",
]);
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("repository_evidence_invalid");
}
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  check(Object.keys(value).every((key) => allowed.includes(key)));
}
function pathOK(path: unknown): path is string {
  return (
    typeof path === "string" &&
    !!path &&
    !path.includes("\0") &&
    Buffer.byteLength(path) <= PATH_BYTES &&
    Buffer.from(path, "utf8").toString("utf8") === path &&
    !isAbsolute(path) &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" && part !== "." && part !== ".." && part !== ".git",
      )
  );
}
function rootOK(root: unknown): root is string {
  return (
    typeof root === "string" &&
    isAbsolute(root) &&
    Buffer.byteLength(root) <= PATH_BYTES &&
    Buffer.from(root, "utf8").toString("utf8") === root &&
    !/[\x00-\x1f\x7f]/.test(root)
  );
}
function hashOK(hash: unknown): boolean {
  return typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);
}
function headOK(head: unknown): boolean {
  return (
    head === null ||
    (typeof head === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
  );
}
function omissionsOK(value: unknown): void {
  check(Array.isArray(value) && value.length <= REPOSITORY_MAX_FILES + 2);
  for (const item of value) {
    const v = record(item);
    keys(v, ["path", "reason"]);
    check(v.path === "*" || pathOK(v.path));
    check(
      typeof v.reason === "string" && /^[a-z_]{1,64}(?::\d+)?$/.test(v.reason),
    );
  }
}
function metadataOK(value: unknown, file: boolean): void {
  const v = record(value);
  keys(
    v,
    file
      ? ["path", "kind", "size", "mode", "sha256", "target", "text", "reason"]
      : ["kind", "size", "mode", "sha256", "target"],
  );
  check(typeof v.kind === "string" && kinds.has(v.kind));
  check(Number.isSafeInteger(v.size) && (v.size as number) >= 0);
  check(
    Number.isSafeInteger(v.mode) &&
      (v.mode as number) >= 0 &&
      (v.mode as number) <= 0o177777,
  );
  if (v.sha256 !== undefined) check(hashOK(v.sha256));
  if (v.target !== undefined)
    check(
      v.kind === "symlink" &&
        typeof v.target === "string" &&
        Buffer.byteLength(v.target) <= PATH_BYTES,
    );
  if (!file) return;
  check(pathOK(v.path));
  if (v.reason !== undefined)
    check(typeof v.reason === "string" && /^[a-z_]{1,64}$/.test(v.reason));
  if (v.kind === "text") {
    check(
      typeof v.text === "string" &&
        Buffer.byteLength(v.text) === v.size &&
        (v.size as number) <= REPOSITORY_FILE_MAX_BYTES &&
        digest(v.text) === v.sha256,
    );
  } else check(v.text === undefined);
  if (v.kind === "symlink")
    check(typeof v.target === "string" && digest(v.target) === v.sha256);
  if (v.kind === "binary") check(hashOK(v.sha256));
  if (v.kind === "omitted") check(typeof v.reason === "string");
}
export function repositorySnapshotHash(snapshot: RepositorySnapshot): string {
  return digest(
    JSON.stringify({
      root: snapshot.root,
      // Missing entries preserve deletion evidence, not present filesystem state.
      // A later fresh baseline may no longer enumerate a committed deletion.
      files: snapshot.files
        .filter((file) => file.kind !== "missing")
        .map(({ text: _text, ...file }) => file),
      complete: snapshot.complete,
      omissions: snapshot.omissions,
    }),
  );
}
export function validateRepositorySnapshot(value: unknown): RepositorySnapshot {
  check(bytes(value) <= REPOSITORY_SNAPSHOT_MAX_BYTES);
  const v = record(value);
  keys(v, [
    "version",
    "root",
    "head",
    "capturedAt",
    "files",
    "complete",
    "omissions",
    "contentHash",
  ]);
  check(
    v.version === 1 &&
      rootOK(v.root) &&
      headOK(v.head) &&
      typeof v.complete === "boolean" &&
      typeof v.capturedAt === "string" &&
      Number.isFinite(Date.parse(v.capturedAt)),
  );
  check(Array.isArray(v.files) && v.files.length <= REPOSITORY_MAX_FILES);
  let previous: string | undefined;
  for (const file of v.files) {
    metadataOK(file, true);
    const path = (file as RepositoryFile).path;
    check(previous === undefined || previous < path);
    previous = path;
  }
  omissionsOK(v.omissions);
  check(!v.complete || (v.omissions as unknown[]).length === 0);
  if (v.complete)
    check(!(v.files as RepositoryFile[]).some((file) => file.reason));
  check(hashOK(v.contentHash));
  const snapshot = v as unknown as RepositorySnapshot;
  check(repositorySnapshotHash(snapshot) === snapshot.contentHash);
  return snapshot;
}
export function validateRepositoryDiffEvidence(
  value: unknown,
): RepositoryDiffEvidence {
  check(bytes(value) <= REPOSITORY_EVIDENCE_MAX_BYTES);
  const v = record(value);
  keys(v, [
    "version",
    "root",
    "status",
    "beforeHash",
    "afterHash",
    "beforeHead",
    "afterHead",
    "changes",
    "patch",
    "omissions",
    "note",
    "error",
  ]);
  check(
    v.version === 1 &&
      rootOK(v.root) &&
      ["complete", "partial", "unavailable"].includes(v.status as string),
  );
  check(v.beforeHash === null || hashOK(v.beforeHash));
  check(v.afterHash === null || hashOK(v.afterHash));
  check(headOK(v.beforeHead) && headOK(v.afterHead));
  check(
    typeof v.patch === "string" &&
      Buffer.byteLength(v.patch) <= REPOSITORY_PATCH_MAX_BYTES &&
      typeof v.note === "string" &&
      !!v.note &&
      Buffer.byteLength(v.note) <= 4096,
  );
  check(Array.isArray(v.changes) && v.changes.length <= REPOSITORY_MAX_FILES);
  let previous: string | undefined;
  for (const item of v.changes) {
    const change = record(item);
    keys(change, ["path", "kind", "before", "after"]);
    check(
      pathOK(change.path) &&
        typeof change.kind === "string" &&
        changes.has(change.kind),
    );
    check(previous === undefined || previous < change.path);
    previous = change.path;
    if (change.before !== null) metadataOK(change.before, false);
    if (change.after !== null) metadataOK(change.after, false);
    check(change.before !== null || change.after !== null);
  }
  omissionsOK(v.omissions);
  if (v.status === "complete")
    check(
      v.beforeHash !== null &&
        v.afterHash !== null &&
        (v.omissions as unknown[]).length === 0 &&
        v.error === undefined,
    );
  if (v.status === "unavailable")
    check(
      (v.changes as unknown[]).length === 0 &&
        v.patch === "" &&
        typeof v.error === "string",
    );
  if (v.error !== undefined)
    check(typeof v.error === "string" && /^[a-z_]{1,80}$/.test(v.error));
  return v as unknown as RepositoryDiffEvidence;
}
export function repositoryDiffEvidenceHash(
  evidence: RepositoryDiffEvidence,
): string {
  return digest(JSON.stringify(validateRepositoryDiffEvidence(evidence)));
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("repository_capture_cancelled");
}
async function git(
  args: string[],
  cwd: string,
  maxBytes: number,
  signal?: AbortSignal,
  allowDiff = false,
): Promise<{ output: string; limited: boolean }> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.untrackedCache=false",
        ...args,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const chunks: Buffer[] = [];
    let length = 0,
      limited = false,
      timedOut = false;
    const cancel = (): void => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, 5000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxBytes - length;
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        length += Math.min(chunk.length, remaining);
      }
      if (chunk.length > remaining) {
        limited = true;
        cancel();
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(new Error("repository_command_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted)
        return reject(new Error("repository_capture_cancelled"));
      if (timedOut) return reject(new Error("repository_command_timeout"));
      if (limited && !allowDiff)
        return reject(new Error("repository_command_output_limit"));
      if (!limited && code !== 0 && !(allowDiff && code === 1))
        return reject(new Error("repository_command_failed"));
      let output: string;
      const raw = Buffer.concat(chunks);
      try {
        // Git -z emits raw filename bytes. Do not substitute invalid UTF-8 and
        // accidentally read another valid filename containing U+FFFD.
        const decoder = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        });
        if (limited && allowDiff) {
          let decoded: string | undefined;
          for (let trim = 0; trim <= Math.min(3, raw.length); trim++) {
            try {
              decoded = decoder.decode(raw.subarray(0, raw.length - trim));
              break;
            } catch {
              /* Truncated UTF-8 at the patch boundary. */
            }
          }
          if (decoded === undefined) throw new Error();
          output = decoded;
        } else output = decoder.decode(raw);
      } catch {
        reject(new Error("repository_output_encoding"));
        return;
      }
      resolve({ output, limited });
    });
  });
}
function sensitive(path: string): boolean {
  const segments = path.split("/");
  const name = segments.at(-1)!;
  return (
    segments.some((part) => [".git", ".ssh", ".gnupg"].includes(part)) ||
    (/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|auth\.json|credentials\.json|id_rsa|id_ed25519)$/i.test(
      name,
    ) &&
      !/^\.env\.(?:example|sample|template)$/i.test(name)) ||
    /\.(?:pem|key|p12|pfx)$/i.test(name)
  );
}
interface RootIdentity {
  dev: number;
  ino: number;
}
async function safeRoot(root: string, identity: RootIdentity): Promise<void> {
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino ||
    (await realpath(root)) !== root
  )
    throw new Error("repository_root_changed");
}
async function safeParents(
  root: string,
  path: string,
  identity: RootIdentity,
): Promise<void> {
  await safeRoot(root, identity);
  let directory = root;
  for (const part of path.split("/").slice(0, -1)) {
    directory = join(directory, part);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("repository_unsafe_path");
  }
}
async function captureFile(
  root: string,
  path: string,
  remaining: number,
  identity: RootIdentity,
  signal?: AbortSignal,
): Promise<{ file: RepositoryFile; readBytes: number }> {
  aborted(signal);
  if (sensitive(path))
    return {
      file: {
        path,
        kind: "omitted",
        size: 0,
        mode: 0,
        reason: "sensitive_path",
      },
      readBytes: 0,
    };
  try {
    await safeParents(root, path, identity);
    const full = join(root, path);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      const targetBytes = await readlink(full, { encoding: "buffer" });
      if (targetBytes.length > PATH_BYTES)
        throw new Error("repository_unsafe_path");
      let target: string;
      try {
        target = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(targetBytes);
      } catch {
        return {
          file: {
            path,
            kind: "omitted",
            size: targetBytes.length,
            mode: 0o120000,
            sha256: digest(targetBytes),
            reason: "unsafe_path",
          },
          readBytes: 0,
        };
      }
      return {
        file: {
          path,
          kind: "symlink",
          size: Buffer.byteLength(target),
          mode: 0o120000,
          sha256: digest(target),
          target,
          reason: "symlink",
        },
        readBytes: 0,
      };
    }
    const mode = info.mode & 0o111 ? 0o100755 : 0o100644;
    if (!info.isFile() || info.nlink !== 1)
      return {
        file: {
          path,
          kind: "omitted",
          size: info.size,
          mode,
          reason: "unsafe_path",
        },
        readBytes: 0,
      };
    if (info.size > REPOSITORY_FILE_MAX_BYTES || info.size > remaining)
      return {
        file: {
          path,
          kind: "omitted",
          size: info.size,
          mode,
          reason:
            info.size > REPOSITORY_FILE_MAX_BYTES ? "file_size" : "total_bytes",
        },
        readBytes: 0,
      };
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.ino !== info.ino ||
        stat.dev !== info.dev
      )
        throw new Error("repository_unsafe_path");
      await safeParents(root, path, identity);
      const buffer = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        aborted(signal);
        const result = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const end = await handle.stat();
      await safeParents(root, path, identity);
      const current = await lstat(full);
      if (
        offset !== info.size ||
        end.size !== info.size ||
        end.mtimeMs !== info.mtimeMs ||
        current.ino !== info.ino ||
        current.dev !== info.dev
      )
        return {
          file: {
            path,
            kind: "omitted",
            size: info.size,
            mode,
            reason: "changed_during_capture",
          },
          readBytes: offset,
        };
      const data = buffer.subarray(0, offset);
      const sha256 = digest(data);
      let text: string;
      try {
        if (data.some((byte) => byte < 32 && ![9, 10, 13].includes(byte)))
          throw new Error();
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(data);
      } catch {
        return {
          file: {
            path,
            kind: "binary",
            size: data.length,
            mode,
            sha256,
            reason: "binary",
          },
          readBytes: offset,
        };
      }
      return {
        file: { path, kind: "text", size: data.length, mode, sha256, text },
        readBytes: offset,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal?.aborted) throw new Error("repository_capture_cancelled");
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        file: { path, kind: "missing", size: 0, mode: 0 },
        readBytes: 0,
      };
    return {
      file: { path, kind: "omitted", size: 0, mode: 0, reason: "unsafe_path" },
      readBytes: 0,
    };
  }
}
export async function captureRepository(
  root: string,
  options: CaptureRepositoryOptions = {},
): Promise<RepositorySnapshot> {
  if (!rootOK(root)) throw new Error("repository_root_invalid");
  const canonical = await realpath(root);
  // Compare with the stored canonical binding before Git can inspect any newly
  // redirected repository. Do not realpath(expectedRoot): that would follow the
  // very replacement this check is intended to reject.
  if (
    options.expectedRoot !== undefined &&
    (!rootOK(options.expectedRoot) || canonical !== options.expectedRoot)
  )
    throw new Error("repository_root_changed");
  const rootInfo = await lstat(canonical);
  if (
    !rootOK(canonical) ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink()
  )
    throw new Error("repository_root_invalid");
  const identity: RootIdentity = { dev: rootInfo.dev, ino: rootInfo.ino };
  await safeRoot(canonical, identity);
  const top = (
    await git(
      ["rev-parse", "--show-toplevel"],
      canonical,
      PATH_BYTES + 1,
      options.signal,
    )
  ).output.trimEnd();
  if (top !== canonical) throw new Error("repository_root_not_toplevel");
  let head: string | null = null;
  await safeRoot(canonical, identity);
  try {
    head = (
      await git(
        ["rev-parse", "--verify", "HEAD"],
        canonical,
        128,
        options.signal,
      )
    ).output.trim();
  } catch (error) {
    if (options.signal?.aborted) throw error;
  }
  if (!headOK(head)) throw new Error("repository_head_invalid");
  await safeRoot(canonical, identity);
  const listing = (
    await git(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      canonical,
      2 * 1024 * 1024,
      options.signal,
    )
  ).output;
  await safeRoot(canonical, identity);
  if (listing && !listing.endsWith("\0"))
    throw new Error("repository_inventory_invalid");
  const paths = new Set(listing.split("\0").filter(Boolean));
  for (const path of options.previousPaths ?? []) {
    if (!pathOK(path)) throw new Error("repository_previous_path_invalid");
    paths.add(path);
  }
  const all = [...paths].sort();
  const files: RepositoryFile[] = [],
    omissions: RepositoryOmission[] = [];
  let readBytes = 0;
  const start = performance.now();
  if (all.length > REPOSITORY_MAX_FILES)
    omissions.push({
      path: "*",
      reason: `file_limit:${all.length - REPOSITORY_MAX_FILES}`,
    });
  for (const path of all.slice(0, REPOSITORY_MAX_FILES)) {
    aborted(options.signal);
    if (!pathOK(path)) {
      omissions.push({ path: "*", reason: "unsafe_path" });
      continue;
    }
    if (performance.now() - start > 10_000) {
      omissions.push({ path: "*", reason: "command_limit" });
      break;
    }
    const captured = await captureFile(
      canonical,
      path,
      Math.max(0, CAPTURE_BYTES - readBytes),
      identity,
      options.signal,
    );
    readBytes += captured.readBytes;
    let file = captured.file;
    if (
      bytes({ files: [...files, file], omissions }) >
      REPOSITORY_SNAPSHOT_MAX_BYTES - 64 * 1024
    )
      file = {
        path,
        kind: "omitted",
        size: file.size,
        mode: file.mode,
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
        reason: "total_bytes",
      };
    files.push(file);
    if (file.reason) omissions.push({ path, reason: file.reason });
  }
  await safeRoot(canonical, identity);
  const snapshot: RepositorySnapshot = {
    version: 1,
    root: canonical,
    head,
    capturedAt: new Date().toISOString(),
    files,
    complete: omissions.length === 0,
    omissions,
    contentHash: "",
  };
  snapshot.contentHash = repositorySnapshotHash(snapshot);
  return validateRepositorySnapshot(snapshot);
}
function metadata(
  file: RepositoryFile | undefined,
): RepositoryFileMetadata | null {
  if (!file || file.kind === "missing") return null;
  return {
    kind: file.kind,
    size: file.size,
    mode: file.mode,
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
    ...(file.target !== undefined ? { target: file.target } : {}),
  };
}
function quote(path: string): string {
  return (
    '"' +
    [...Buffer.from(path, "utf8")]
      .map((byte) => {
        if (byte === 34) return '\\"';
        if (byte === 92) return "\\\\";
        return byte >= 32 && byte < 127
          ? String.fromCharCode(byte)
          : "\\" + byte.toString(8).padStart(3, "0");
      })
      .join("") +
    '"'
  );
}

async function patchFor(
  before: RepositoryFile | undefined,
  after: RepositoryFile | undefined,
  directory: string,
  signal?: AbortSignal,
): Promise<{ patch: string; limited: boolean }> {
  const left =
    before?.kind === "text" ? join(directory, "before") : "/dev/null";
  const right = after?.kind === "text" ? join(directory, "after") : "/dev/null";
  if (left === right) return { patch: "", limited: false };
  if (left !== "/dev/null")
    await writeFile(left, before!.text!, { mode: 0o600 });
  if (right !== "/dev/null")
    await writeFile(right, after!.text!, { mode: 0o600 });
  const result = await git(
    [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      "--text",
      "--unified=3",
      "--",
      left,
      right,
    ],
    directory,
    REPOSITORY_PATCH_MAX_BYTES,
    signal,
    true,
  );
  const path = after?.path ?? before!.path;
  let hunks = false;
  const lines = result.output.split("\n").map((line) => {
    if (line.startsWith("@@")) hunks = true;
    if (hunks) return line;
    if (line.startsWith("diff --git ")) {
      const modes =
        before?.kind === "text" &&
        after?.kind === "text" &&
        before.mode !== after.mode
          ? `\nold mode ${before.mode.toString(8)}\nnew mode ${after.mode.toString(8)}`
          : "";
      return `diff --git ${quote(`a/${path}`)} ${quote(`b/${path}`)}${modes}`;
    }
    if (line.startsWith("new file mode ") && after)
      return `new file mode ${after.mode.toString(8)}`;
    if (line.startsWith("deleted file mode ") && before)
      return `deleted file mode ${before.mode.toString(8)}`;
    if (line.startsWith("--- "))
      return `--- ${left === "/dev/null" ? "/dev/null" : quote(`a/${path}`)}`;
    if (line.startsWith("+++ "))
      return `+++ ${right === "/dev/null" ? "/dev/null" : quote(`b/${path}`)}`;
    return line;
  });
  return { patch: lines.join("\n"), limited: result.limited };
}
export async function compareRepository(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
  options: CompareRepositoryOptions = {},
): Promise<RepositoryDiffEvidence> {
  validateRepositorySnapshot(before);
  validateRepositorySnapshot(after);
  if (before.root !== after.root) throw new Error("repository_root_changed");
  aborted(options.signal);
  const base = await realpath(options.temporaryDirectory ?? tmpdir());
  const rel = relative(before.root, base);
  if (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
    throw new Error("repository_scratch_inside_root");
  const directory = await mkdtemp(join(base, ".szpont-diff-"));
  const inventory: RepositoryChange[] = [],
    omissions: RepositoryOmission[] = [
      ...before.omissions,
      ...after.omissions,
    ].slice(0, REPOSITORY_MAX_FILES);
  let patch = "";
  const started = performance.now();
  const previous = new Map(before.files.map((file) => [file.path, file]));
  const current = new Map(after.files.map((file) => [file.path, file]));
  try {
    for (const path of [
      ...new Set([...previous.keys(), ...current.keys()]),
    ].sort()) {
      aborted(options.signal);
      const left = previous.get(path),
        right = current.get(path);
      const a = metadata(left),
        b = metadata(right);
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      const kind: RepositoryChange["kind"] = !a
        ? "added"
        : !b
          ? "deleted"
          : a.kind !== b.kind
            ? "type_changed"
            : a.sha256 === b.sha256 && a.mode !== b.mode
              ? "mode_changed"
              : "modified";
      inventory.push({ path, kind, before: a, after: b });
      if (
        performance.now() - started > 10_000 ||
        Buffer.byteLength(patch) >= REPOSITORY_PATCH_MAX_BYTES
      ) {
        omissions.push({ path, reason: "patch_limit" });
        continue;
      }
      if (
        (left && !["text", "missing"].includes(left.kind)) ||
        (right && !["text", "missing"].includes(right.kind))
      )
        continue;
      const rendered =
        kind === "mode_changed" && left && right
          ? {
              patch: `diff --git ${quote(`a/${path}`)} ${quote(`b/${path}`)}\nold mode ${left.mode.toString(8)}\nnew mode ${right.mode.toString(8)}\n`,
              limited: false,
            }
          : await patchFor(left, right, directory, options.signal);
      if (
        rendered.limited ||
        Buffer.byteLength(patch + rendered.patch) > REPOSITORY_PATCH_MAX_BYTES
      ) {
        omissions.push({ path, reason: "patch_limit" });
        const available = Math.max(
          0,
          REPOSITORY_PATCH_MAX_BYTES - Buffer.byteLength(patch),
        );
        patch += Buffer.from(rendered.patch)
          .subarray(0, Math.max(0, available - 4))
          .toString("utf8");
      } else patch += rendered.patch;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const evidence: RepositoryDiffEvidence = {
    version: 1,
    root: before.root,
    status:
      before.complete && after.complete && !omissions.length
        ? "complete"
        : "partial",
    beforeHash: before.contentHash,
    afterHash: after.contentHash,
    beforeHead: before.head,
    afterHead: after.head,
    changes: inventory,
    patch,
    omissions: omissions.slice(0, REPOSITORY_MAX_FILES),
    note: NOTE,
  };
  let removed = 0;
  while (evidence.changes.length > REPOSITORY_MAX_FILES) {
    evidence.changes.pop();
    removed++;
  }
  while (
    bytes(evidence) > REPOSITORY_EVIDENCE_MAX_BYTES - 1024 &&
    evidence.changes.length
  ) {
    evidence.changes.pop();
    removed++;
  }
  while (
    bytes(evidence) > REPOSITORY_EVIDENCE_MAX_BYTES - 1024 &&
    evidence.omissions.length
  ) {
    evidence.omissions.pop();
    removed++;
  }
  if (removed) {
    evidence.status = "partial";
    evidence.omissions.push({
      path: "*",
      reason: `inventory_limit:${removed}`,
    });
  }
  return validateRepositoryDiffEvidence(evidence);
}
