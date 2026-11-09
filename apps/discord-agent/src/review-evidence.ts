import { constants } from "node:fs";
import { mkdir, lstat, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SNOWFLAKE } from "./config.js";
import {
  validateRepositoryDiffEvidence,
  REPOSITORY_EVIDENCE_MAX_BYTES,
  type RepositoryDiffEvidence,
} from "./repository-diff.js";

/** Derived private read material. SQLite remains the authoritative backup. */
export async function exportReviewEvidence(
  stateDir: string,
  jobId: string,
  step: number,
  evidence: RepositoryDiffEvidence,
): Promise<string> {
  if (
    !SNOWFLAKE.test(jobId) ||
    !Number.isSafeInteger(step) ||
    step < 1 ||
    step > 32
  )
    throw new Error("Invalid goal evidence identity");
  const value = validateRepositoryDiffEvidence(evidence);
  const base = await lstat(stateDir);
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    (base.mode & 0o077) !== 0 ||
    (process.getuid && base.uid !== process.getuid())
  )
    throw new Error("Unsafe engine state directory");
  let directory = stateDir;
  for (const part of ["goal-review-evidence", jobId]) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Unsafe goal evidence directory");
  }
  const path = join(directory, `step-${step}.json`);
  const bytes = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  if (bytes.length > REPOSITORY_EVIDENCE_MAX_BYTES + 1)
    throw new Error("Goal evidence limit exceeded");
  const existing = async (): Promise<boolean> => {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        info.size > REPOSITORY_EVIDENCE_MAX_BYTES + 1 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error("Unsafe goal evidence file");
      if (!(await handle.readFile()).equals(bytes))
        throw new Error("Saved goal evidence differs from committed state");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    } finally {
      await handle?.close();
    }
  };
  if (await existing()) return path;
  const temporary = join(directory, `.step-${step}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(await existing())
      )
        throw error;
    }
    await unlink(temporary);
    const parent = await open(directory, constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return path;
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
