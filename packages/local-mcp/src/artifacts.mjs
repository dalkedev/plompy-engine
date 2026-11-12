import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

const MAX_BYTES = 1_048_576;
const MAX_RECORDS = 1000;
const MAX_FILES = 2000;
const transactions = new Map();
const extensions = { csv: ".csv", json: ".json", markdown: ".md" };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

function ownedFile(info) {
  return info.isFile() && info.nlink === 1 && !(info.mode & 0o077) &&
    (!process.getuid || info.uid === process.getuid());
}

async function safeRoot(input) {
  if (typeof input !== "string" || !isAbsolute(input) || resolve(input) === parse(input).root)
    fail("An absolute, dedicated artifact directory is required.");
  const root = resolve(input);
  const chain = [];
  for (let cursor = root; cursor !== dirname(cursor); cursor = dirname(cursor)) chain.unshift(cursor);
  for (const path of chain) {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      info = await lstat(path);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail("Artifact directories cannot contain symlinks.");
    if (path === root && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))
      fail("The artifact directory must be owned by this user with mode 0700.");
  }
  return root;
}

function filename(name, format) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name) || name.includes(".."))
    fail("Use a flat artifact filename of at most 120 letters, numbers, dots, dashes or underscores.");
  if (format && !name.endsWith(extensions[format])) fail(`The artifact filename must end in ${extensions[format]}.`);
  if (!format && !Object.values(extensions).some((extension) => name.endsWith(extension)))
    fail("Only CSV, JSON and Markdown artifacts are supported.");
  return name;
}

function validateRecords(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) fail("Records must be an array of at most 1000 rows.");
  const columns = new Set();
  for (const row of records) {
    if (!row || typeof row !== "object" || Array.isArray(row) || ![Object.prototype, null].includes(Object.getPrototypeOf(row)))
      fail("Each record must be a plain object of scalar values.");
    if (Object.keys(row).length > 64) fail("An artifact may contain at most 64 columns.");
    for (const [key, value] of Object.entries(row)) {
      if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) fail("Invalid artifact column name.");
      columns.add(key);
      if (columns.size > 64) fail("An artifact may contain at most 64 columns.");
      if (!(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length <= 32_768 && !value.includes("\u0000"))))
        fail("Artifact cells must be bounded strings, finite numbers, booleans or null.");
    }
  }
  return [...columns];
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  // Excel and similar readers can interpret formula prefixes even after whitespace.
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function serialize({ format, records, content }) {
  if (!Object.hasOwn(extensions, format)) fail("Artifact format must be csv, json or markdown.");
  let text;
  if (format === "markdown") {
    if (typeof content !== "string" || records !== undefined || content.includes("\u0000"))
      fail("Markdown artifacts require content and no records.");
    text = content;
  } else {
    if (content !== undefined) fail("CSV and JSON artifacts require records, not content.");
    const columns = validateRecords(records);
    text = format === "json" ? JSON.stringify(records, null, 2) + "\n" :
      [columns.map(csvCell).join(","), ...records.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n") + "\r\n";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_BYTES) fail("Artifact exceeds the 1 MiB limit.");
  return bytes;
}

async function readPrivate(path) {
  const original = await lstat(path);
  if (!ownedFile(original)) fail("Artifact is not a private, regular, single-link file.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!ownedFile(info) || info.ino !== original.ino || info.dev !== original.dev || info.size > MAX_BYTES)
      fail("Artifact is unsafe, changed, or exceeds the size limit.");
    const value = await file.readFile();
    if (value.length > MAX_BYTES) fail("Artifact exceeds the size limit.");
    return value;
  } finally { await file.close(); }
}

// Fully write a private temporary file, then link atomically without replacement.
// A crash before linking never exposes partial content under the public name.
async function putImmutable(root, name, bytes) {
  const destination = join(root, name);
  try {
    const existing = await readPrivate(destination);
    if (!existing.equals(bytes)) fail("An artifact or idempotency key already exists with different content. Choose a new name and key.");
    return true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(root, `.pending-${randomUUID()}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    try { await link(temporary, destination); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await unlink(temporary);
      const existing = await readPrivate(destination);
      if (!existing.equals(bytes)) fail("An artifact or idempotency key already exists with different content. Choose a new name and key.");
      return true;
    }
    await unlink(temporary);
    return false;
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function writeArtifact(root, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("An artifact specification is required.");
  const bytes = serialize(input);
  const name = filename(input.name, input.format);
  const path = await safeRoot(root);
  const sha256 = digest(bytes);
  if (input.idempotencyKey !== undefined) {
    if (typeof input.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.idempotencyKey))
      fail("An idempotency key must contain 8 to 128 letters, numbers, dashes or underscores.");
    await putImmutable(path, `.plompy-key-${digest(input.idempotencyKey)}.json`,
      Buffer.from(JSON.stringify({ name, format: input.format, sha256 }) + "\n"));
  }
  const reused = await putImmutable(path, name, bytes);
  return { name, format: input.format, bytes: bytes.length, sha256, reused };
}

export async function exportArtifact(root, input) {
  // Serialize writes within this service. Atomic no-replace linking still protects
  // against another process, but its brief two-link publication must not be read
  // by a simultaneous retry in this process as if it were an unsafe hard link.
  const key = await safeRoot(root);
  const previous = transactions.get(key) || Promise.resolve();
  const operation = previous.then(() => writeArtifact(key, input));
  const barrier = operation.catch(() => {});
  transactions.set(key, barrier);
  try { return await operation; }
  finally { if (transactions.get(key) === barrier) transactions.delete(key); }
}

export async function readArtifact(root, { name } = {}) {
  const path = await safeRoot(root);
  await transactions.get(path);
  return { name: filename(name), content: (await readPrivate(join(path, name))).toString("utf8") };
}

export async function listArtifacts(root) {
  const path = await safeRoot(root);
  await transactions.get(path);
  const names = await readdir(path);
  if (names.length > MAX_FILES) fail("Too many files in the artifact directory; archive older results first.");
  const results = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    try { filename(name); } catch { continue; }
    const value = await readPrivate(join(path, name));
    results.push({ name, bytes: value.length, sha256: digest(value) });
  }
  return results;
}
