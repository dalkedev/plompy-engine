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
import { Store, SCHEMA_VERSION } from "../apps/discord-agent/dist/store.js";
import {
  imageDigest,
  materializeImages,
} from "../apps/discord-agent/dist/images.js";
import { codexArgs } from "../apps/discord-agent/dist/codex.js";
import { validateWorkOutcome } from "../apps/discord-agent/dist/workflow.js";
import { snapshotState } from "./state-snapshot.mjs";

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
const workflowConfig = {
  workspace: process.env.SZPONT_WORKSPACE,
  artifactsDir: process.env.SZPONT_ARTIFACTS_DIR,
  browserDir: process.env.SZPONT_BROWSER_DIR,
};
for (const session of [null, "11111111-1111-4111-8111-111111111111"]) {
  const args = codexArgs(workflowConfig, session, { workflow: true });
  const schemaPath = args[args.indexOf("--output-schema") + 1];
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.match(
    execFileSync("codex", [...args, "--help"], {
      encoding: "utf8",
      timeout: 10_000,
    }),
    /--output-schema/,
  );
}
// Exercise the exact packaged Codex parser with native images on initial and
// resumed turns. --help is inserted before our positional delimiter, so this
// parses the real flags without opening a session, authenticating or inference.
const syntheticPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
  "base64",
);
const imageFiles = await materializeImages(process.env.SZPONT_STATE_DIR, [
  {
    mediaType: "image/png",
    sha256: imageDigest(syntheticPng),
    data: syntheticPng,
  },
]);
try {
  for (const session of [null, "11111111-1111-4111-8111-111111111111"]) {
    const args = codexArgs(workflowConfig, session, {
      workflow: true,
      images: imageFiles.paths,
    });
    const delimiter = args.indexOf("--");
    assert.ok(delimiter > args.indexOf("--image"));
    args.splice(delimiter, 0, "--help");
    const help = execFileSync("codex", args, {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.match(help, /--image/);
    assert.match(help, /--output-schema/);
  }
} finally {
  await imageFiles.cleanup();
}
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
// Exercise the shipped workflow/store/snapshot modules on fresh synthetic state.
const workflowRoot = await mkdtemp(
  join(process.env.SZPONT_STATE_DIR, "work-smoke-"),
);
let workStore;
try {
  const source = join(workflowRoot, "source.sqlite");
  workStore = new Store(source);
  assert.equal(
    workStore.db.prepare("PRAGMA user_version").get().user_version,
    SCHEMA_VERSION,
  );
  workStore.enqueueWorkflow(id, thread, "Synthetic bounded goal", 60_000);
  workStore.claim();
  workStore.setSession(thread, "11111111-1111-4111-8111-111111111111");
  assert.equal(
    workStore.checkpoint(
      id,
      validateWorkOutcome(
        JSON.stringify({
          outcome: "continue",
          summary: "First verified step",
          nextAction: "Inspect synthetic result",
        }),
      ),
      10,
    ).continued,
    true,
  );
  workStore.close();
  workStore = new Store(source);
  assert.equal(workStore.workflow(id).step_count, 1);
  assert.equal(
    workStore.session(thread),
    "11111111-1111-4111-8111-111111111111",
  );
  workStore.claim();
  workStore.checkpoint(
    id,
    {
      outcome: "completed",
      summary: "Synthetic goal completed",
      nextAction: "",
    },
    10,
  );
  const generation = workStore.effect(thread).generation;
  workStore.completeEffect(thread, generation, "transcript");
  workStore.completeEffect(thread, generation, "memory");
  assert.equal(workStore.pendingEffects().length, 0);
  const destination = join(workflowRoot, "snapshot.sqlite");
  const snapshot = await snapshotState({
    operation: "backup",
    source,
    destination,
  });
  assert.equal(snapshot.schemaVersion, SCHEMA_VERSION);
  workStore.close();
  workStore = new Store(destination);
  assert.equal(workStore.get(id).status, "succeeded");
  assert.equal(workStore.workflowSteps(id).length, 2);
} finally {
  workStore?.close();
  await rm(workflowRoot, { recursive: true, force: true });
}
await writeFile(
  join(process.env.SZPONT_ARTIFACTS_DIR, "container-smoke.txt"),
  "synthetic\n",
  { mode: 0o600 },
);
console.log(
  "PASS: non-root Node/Codex image, private cache/workspace, read-only source, SQLite persistence, bundled workflow schema, native fresh/resumed image inputs, resumed checkpoints, consistent state snapshot, separate artifacts and no baked authentication.",
);
