// No model/account/network use: exercise the real Codex inner sandbox on this host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const workspace = process.env.SZPONT_WORKSPACE;
const artifacts = process.env.SZPONT_ARTIFACTS_DIR;
const temporary = [];
try {
  const privateDirectory = async (parent) => {
    const directory = await mkdtemp(join(parent, ".szpont-sandbox-check-"));
    temporary.push(directory);
    return directory;
  };
  const workspaceProbe = join(await privateDirectory(workspace), "allowed");
  const artifactProbe = join(await privateDirectory(artifacts), "allowed");
  const outside = join(
    await privateDirectory(process.env.CODEX_HOME),
    "must-deny",
  );
  // Prove the outer non-root process can write this private volume, so an inner
  // denial demonstrates the Codex boundary rather than rootfs mount permissions.
  await writeFile(outside, "outer process can write\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rm(outside);
  const environment = { ...process.env };
  delete environment.DISCORD_BOT_TOKEN;
  delete environment.SZPONT_GIT_SSH_COMMAND;
  execFileSync(
    "codex",
    [
      "sandbox",
      "--permission-profile",
      "szpont-container-check",
      "-C",
      workspace,
      "-c",
      `permissions.szpont-container-check={extends=":workspace",filesystem={${JSON.stringify(artifacts)}="write"},network={enabled=true}}`,
      "--",
      "/bin/sh",
      "-ec",
      'printf allowed > "$1"; printf allowed > "$2"; cache=$(npm config get cache); mkdir -p "$cache"; cache_probe=$(mktemp "$cache/.szpont-cache-check.XXXXXX"); printf cached > "$cache_probe"; rm "$cache_probe"; if printf forbidden > "$3" 2>/dev/null; then exit 42; fi',
      "container-sandbox-check",
      workspaceProbe,
      artifactProbe,
      outside,
    ],
    {
      env: environment,
      timeout: 15_000,
      maxBuffer: 65_536,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(await readFile(workspaceProbe, "utf8"), "allowed");
  assert.equal(await readFile(artifactProbe, "utf8"), "allowed");
  await assert.rejects(access(outside), { code: "ENOENT" });
  console.log(
    "PASS: Codex sandbox permits workspace/artifact/npm-cache writes and denies writes to the separate auth volume.",
  );
} catch {
  console.error(
    "FAIL: Codex sandbox preflight. Check namespace support, the supplied seccomp profile and the host AppArmor policy; do not disable sandboxing. See docs/docker.md.",
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled(
    temporary.map((path) => rm(path, { recursive: true, force: true })),
  );
}
