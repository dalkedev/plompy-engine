import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(
  new URL("./docker-entrypoint.sh", import.meta.url),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "szpont-entrypoint-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "id"), "#!/bin/sh\nprintf '1000\\n'\n", {
    mode: 0o700,
  });
  await writeFile(
    join(bin, "flock"),
    `#!/bin/sh
printf '%s\\n' "$@" > "$CAPTURE/flock"
if [ "\${BLOCK_LOCK:-}" = yes ]; then exit 75; fi
shift 5
exec "$@"
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "node"),
    `#!/bin/sh
printf '%s\\n' "$@" > "$CAPTURE/node"
printf '%s\\n' "\${DISCORD_BOT_TOKEN-unset}" "\${SZPONT_GIT_SSH_COMMAND-unset}" "\${GH_TOKEN-unset}" "\${GITHUB_TOKEN-unset}" "\${GH_ENTERPRISE_TOKEN-unset}" "\${GITHUB_ENTERPRISE_TOKEN-unset}" "\${GH_CONFIG_DIR-unset}" > "$CAPTURE/environment"
`,
    { mode: 0o700 },
  );
  return {
    root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: join(root, "home"),
      SZPONT_STATE_DIR: join(root, "state"),
      SZPONT_BROWSER_DIR: join(root, "browser"),
      GH_CONFIG_DIR: join(root, "github"),
      DISCORD_BOT_TOKEN: "synthetic-discord-token",
      SZPONT_GIT_SSH_COMMAND: "synthetic-private-command",
      GH_TOKEN: "synthetic-github-token",
      GITHUB_TOKEN: "synthetic-github-token",
      GH_ENTERPRISE_TOKEN: "synthetic-github-token",
      GITHUB_ENTERPRISE_TOKEN: "synthetic-github-token",
      CAPTURE: root,
    },
  };
}

test("container integration setup holds the engine lock and never passes service tokens", async () => {
  const { root, env } = await fixture();
  try {
    const result = spawnSync(
      "/bin/sh",
      [entrypoint, "integrations", "add", "github"],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      (await readFile(join(root, "flock"), "utf8")).trim().split("\n"),
      [
        "--no-fork",
        "-n",
        "-E",
        "75",
        join(root, "state/engine.lock"),
        "node",
        "/opt/szpont/scripts/integrations.mjs",
        "add",
        "github",
      ],
    );
    assert.deepEqual(
      (await readFile(join(root, "node"), "utf8")).trim().split("\n"),
      ["/opt/szpont/scripts/integrations.mjs", "add", "github"],
    );
    assert.deepEqual(
      (await readFile(join(root, "environment"), "utf8")).trim().split("\n"),
      ["unset", "unset", "unset", "unset", "unset", "unset", env.GH_CONFIG_DIR],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("container integration setup exits on a busy engine before dispatching the CLI", async () => {
  const { root, env } = await fixture();
  try {
    const result = spawnSync(
      "/bin/sh",
      [entrypoint, "integrations", "status"],
      {
        env: { ...env, BLOCK_LOCK: "yes" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 75, result.stderr);
    await assert.rejects(readFile(join(root, "node")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("container doctor preserves only the Discord credential needed for explicit REST inspection", async () => {
  const { root, env } = await fixture();
  try {
    const result = spawnSync(
      "/bin/sh",
      [entrypoint, "doctor", "--check-discord", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      (await readFile(join(root, "node"), "utf8")).trim().split("\n"),
      ["/opt/szpont/scripts/doctor.mjs", "--check-discord", "--json"],
    );
    assert.equal((await stat(env.SZPONT_BROWSER_DIR)).mode & 0o777, 0o700);
    await assert.rejects(stat(env.SZPONT_STATE_DIR), { code: "ENOENT" });
    assert.deepEqual(
      (await readFile(join(root, "environment"), "utf8")).trim().split("\n"),
      [
        env.DISCORD_BOT_TOKEN,
        "unset",
        "unset",
        "unset",
        "unset",
        "unset",
        env.GH_CONFIG_DIR,
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const command of ["setup", "acceptance", "installation-smoke"]) {
  test(`container ${command} dispatch preserves argv and excludes existing service credentials`, async () => {
    const { root, env } = await fixture();
    try {
      const args = command === "installation-smoke" ? [] : ["--help"];
      const result = spawnSync("/bin/sh", [entrypoint, command, ...args], {
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        (await readFile(join(root, "node"), "utf8")).trim().split("\n"),
        [`/opt/szpont/scripts/${command}.mjs`, ...args],
      );
      assert.deepEqual(
        (await readFile(join(root, "environment"), "utf8")).trim().split("\n"),
        [
          "unset",
          "unset",
          "unset",
          "unset",
          "unset",
          "unset",
          env.GH_CONFIG_DIR,
        ],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
