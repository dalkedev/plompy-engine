import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../dist/engine.js";
import { Store } from "../dist/store.js";

const thread = "9555000000000000001";
const job = "9555000000000001001";
const cancel = "9555000000000001002";
const sessionId = "01a12345-1234-7456-8456-123456789abc";

test("owner cancellation after a committed continuation checkpoint prevents its next process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "szpont-cancel-boundary-"));
  for (const name of [
    "workspace/agent/memory",
    "workspace/agent/conversations",
    "state",
    "artifacts",
    "codex",
    "browser",
  ])
    await mkdir(join(root, name), { recursive: true });
  for (const name of ["SOUL", "USER", "MEMORY", "POLICY"])
    await writeFile(
      join(root, `workspace/agent/${name}.md`),
      `# Synthetic ${name}`,
    );
  const config = {
    guildId: "111111111111111111",
    ownerId: "222222222222222222",
    botId: "333333333333333333",
    parentId: "444444444444444444",
    token: "synthetic-discord-secret",
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    codexHome: join(root, "codex"),
    browserDir: join(root, "browser"),
    codexBin: "fake",
    timeoutMs: 600_000,
  };
  const store = new Store(join(root, "state/queue.sqlite"));
  let releaseNotice;
  const noticeWait = new Promise((resolve) => {
    releaseNotice = resolve;
  });
  let reachedCheckpointNotice = false;
  let signalCheckpointNotice;
  const checkpointNotice = new Promise((resolve) => {
    signalCheckpointNotice = resolve;
  });
  const notices = [];
  let runs = 0;
  const engine = new Engine(
    config,
    store,
    {
      typing: async () => {},
      send: async (_channel, text) => {
        notices.push(text);
        if (text.includes("checkpoint saved")) {
          reachedCheckpointNotice = true;
          signalCheckpointNotice();
          await noticeWait;
        }
      },
    },
    {
      ready: async () => true,
      persist: async () => {},
      sync: async () => "clean",
      run: async (_config, _prompt, session, save) => {
        runs++;
        if (!session) save(sessionId);
        return {
          ok: true,
          error: null,
          sessionId,
          output: JSON.stringify({
            outcome: runs === 1 ? "continue" : "completed",
            summary: "Verified synthetic step",
            nextAction: runs === 1 ? "Another synthetic step" : "",
          }),
        };
      },
    },
  );
  t.after(async () => {
    releaseNotice();
    engine.stop();
    await engine.kick();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.enqueueWorkflow(job, thread, "Bounded synthetic goal", 60_000);
  const executing = engine.kick();
  let noticeTimeout;
  try {
    await Promise.race([
      checkpointNotice,
      new Promise((_, reject) => {
        noticeTimeout = setTimeout(
          () =>
            reject(
              new Error(
                "The continuation checkpoint notice was not reached within 10 seconds",
              ),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(noticeTimeout);
  }
  assert.equal(reachedCheckpointNotice, true);
  assert.equal(store.get(job).status, "queued");
  await engine.accept({
    id: cancel,
    guildId: config.guildId,
    authorId: config.ownerId,
    channelId: thread,
    parentId: config.parentId,
    bot: false,
    webhook: false,
    thread: true,
    attachments: 0,
    content: `!cancel ${job}`,
  });
  releaseNotice();
  await executing;
  assert.equal(
    runs,
    1,
    "a cancelled continuation must not start another Codex process",
  );
  assert.equal(store.get(job).status, "cancelled");
  assert.equal(store.workflow(job).state, "cancelled");
});

test("status does not recommend an ancestor recovery after its descendant exhausted the workflow budget", async (t) => {
  const { threadStatus } = await import("../dist/status.js");
  const store = new Store(":memory:");
  t.after(() => store.close());
  const recovered = "9555000000000001003";
  const again = "9555000000000001004";
  store.enqueueWorkflow(job, thread, "Bounded synthetic goal", 60_000);
  store.claim();
  store.finish(job, "interrupted", "", "task_timeout", 1000);
  store.recover(job, thread, recovered);
  store.claim();
  store.finish(recovered, "interrupted", "", "task_timeout", 59_000);
  assert.throws(() => store.recover(job, thread, again), /budget is exhausted/);
  const next = threadStatus(store, thread, true)
    .split("\n")
    .find((line) => line.startsWith("Next:"));
  assert.doesNotMatch(next, /!recover/);
  assert.match(next, /!new-session/);
});

test("startup cannot refund an uncheckpointed workflow process allowance on manual recovery", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.enqueueWorkflow(job, thread, "Bounded synthetic goal", 60_000);
  store.claim();
  store.checkpoint(
    job,
    {
      outcome: "continue",
      summary: "Verified first step",
      nextAction: "Continue remaining work",
    },
    1000,
  );
  assert.equal(store.recoverStartup(), 0);
  assert.equal(
    store.workflow(job).elapsed_ms,
    1000,
    "a verified queued checkpoint retains its remaining allowance",
  );
  store.claim();
  // A host crash loses the process duration and its completion receipt. The
  // process may already have consumed the entire remaining allowance.
  store.recoverStartup();
  const workflow = store.workflow(job);
  assert.equal(workflow.state, "blocked");
  assert.equal(workflow.step_count, 1);
  assert.equal(workflow.last_summary, "Verified first step");
  assert.ok(
    workflow.elapsed_ms >= workflow.budget_ms,
    "unobserved execution must not become free budget after a crash",
  );
  assert.throws(
    () => store.recover(job, thread, cancel),
    /budget is exhausted/,
  );
  assert.equal(store.get(cancel), undefined);
});
