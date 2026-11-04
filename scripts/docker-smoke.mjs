// Offline image acceptance only. This never connects to Discord or invokes inference.
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { Store } from "../apps/discord-agent/dist/store.js";

assert.notEqual(process.getuid(), 0, "runtime must be non-root");
assert.match(process.version, /^v24\./, "runtime must use Node 24");
assert.equal(process.env.HOME, "/tmp/szpont-home");
assert.equal((await stat(process.env.HOME)).mode & 0o777, 0o700);
const npmCache = execFileSync("npm", ["config", "get", "cache"], {
  encoding: "utf8",
  timeout: 10_000,
}).trim();
assert.equal(npmCache, join(process.env.HOME, ".npm"));
await mkdir(npmCache, { recursive: true, mode: 0o700 });
const cacheProbe = await mkdtemp(join(npmCache, "szpont-smoke-"));
try {
  await writeFile(join(cacheProbe, "writable"), "synthetic\n", { mode: 0o600 });
} finally {
  await rm(cacheProbe, { recursive: true, force: true });
}
assert.equal(
  execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  "codex-cli 0.166.0",
);
const adapterFlags = [
  "--no-daemon",
  "-C",
  process.env.SZPONT_WORKSPACE,
  "--sandbox",
  "workspace-write",
  "--ask-for-approval",
  "never",
  "--search",
  "-c",
  "sandbox_workspace_write.network_access=true",
  "--add-dir",
  process.env.SZPONT_ARTIFACTS_DIR,
  "--add-dir",
  process.env.SZPONT_BROWSER_DIR,
  "exec",
];
assert.match(
  execFileSync(
    "codex",
    [...adapterFlags, "--json", "--color", "never", "--help"],
    { encoding: "utf8", timeout: 10_000 },
  ),
  /Usage:/,
);
assert.match(
  execFileSync(
    "codex",
    [
      ...adapterFlags,
      "resume",
      "--json",
      "11111111-1111-4111-8111-111111111111",
      "-",
      "--help",
    ],
    { encoding: "utf8", timeout: 10_000 },
  ),
  /Usage:/,
);
assert.equal(
  process.env.DISCORD_BOT_TOKEN,
  undefined,
  "smoke must not receive a bot token",
);
await assert.rejects(access(join(process.env.CODEX_HOME, "auth.json")), {
  code: "ENOENT",
});
await assert.rejects(
  writeFile("/opt/szpont/image-must-stay-read-only", "test"),
);
assert.equal(
  execFileSync("git", ["branch", "--show-current"], {
    cwd: process.env.SZPONT_WORKSPACE,
    encoding: "utf8",
  }).trim(),
  "memory",
);
const policy = await readFile(
  join(process.env.SZPONT_WORKSPACE, "agent/POLICY.md"),
  "utf8",
);
assert.ok(policy.length > 0, "synthetic workspace policy must be initialized");
assert.equal((await stat(process.env.SZPONT_WORKSPACE)).mode & 0o777, 0o700);

const holder = spawn(
  "flock",
  [
    "--no-fork",
    "-n",
    "-E",
    "75",
    join(process.env.SZPONT_STATE_DIR, "engine.lock"),
    "/bin/sh",
    "-ec",
    "printf 'locked\\n'; exec sleep 30",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let timer;
try {
  await Promise.race([
    once(holder.stdout, "data"),
    once(holder, "exit").then(() => {
      throw new Error("Lock holder exited early");
    }),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Lock holder timed out")),
        3000,
      );
    }),
  ]);
  const competing = spawnSync(
    "/opt/szpont/scripts/docker-entrypoint.sh",
    ["init"],
    { timeout: 3000 },
  );
  assert.equal(
    competing.status,
    75,
    "a competing entrypoint must stop at the state lock",
  );
} finally {
  clearTimeout(timer);
  if (holder.exitCode === null && holder.signalCode === null) {
    const closed = once(holder, "exit");
    holder.kill("SIGTERM");
    await closed;
  }
}

const path = join(process.env.SZPONT_STATE_DIR, "container-smoke.sqlite");
const store = new Store(path);
const id = "111111111111111111",
  thread = "222222222222222222";
store.enqueue(id, thread, "Synthetic offline container smoke");
assert.equal(store.get(id)?.status, "queued");
store.close();
const reopened = new Store(path);
assert.equal(reopened.get(id)?.prompt, "Synthetic offline container smoke");
reopened.close();
await writeFile(
  join(process.env.SZPONT_ARTIFACTS_DIR, "container-smoke.txt"),
  "synthetic\n",
  { mode: 0o600 },
);
console.log(
  "PASS: non-root Node/Codex image, writable private npm cache, private workspace, read-only source, SQLite persistence, separate artifacts and no baked authentication.",
);
