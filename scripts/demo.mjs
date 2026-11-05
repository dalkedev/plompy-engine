import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../apps/discord-agent/dist/engine.js";
import { Store } from "../apps/discord-agent/dist/store.js";

const modes = ["session", "recovery", "providers"];
const thread = (n) => String(930000000000000000n + BigInt(n));
const identity = {
  guildId: "910000000000000001",
  ownerId: "910000000000000002",
  botId: "910000000000000003",
  parentId: "910000000000000004",
};
const label = (provider) =>
  ({ codex: "Codex", claude: "Claude Code", opencode: "OpenCode" })[provider];

async function scenario(mode, write) {
  const root = await mkdtemp(join(tmpdir(), "szpont-offline-demo-"));
  let store,
    engine,
    nextMessage = 0,
    nextSession = 0;
  const transcript = [],
    runs = [],
    ready = { codex: true, claude: true, opencode: true };
  const names = new Map(),
    scripted = [];
  const config = {
    ...identity,
    token: "synthetic-demo-token",
    timeoutMs: 1000,
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    browserDir: join(root, "browser"),
    codexHome: join(root, "codex"),
    codexBin: "not-used-in-offline-demo",
  };
  const line = (kind, text) => write(`${kind.padEnd(10)} ${text}`);
  const state = (name, id, taskId) => {
    const job = store.get(taskId);
    line(
      "state",
      `${name} · ${job.status} · ${label(store.provider(id))} · session=${store.session(id) ? "saved" : "none"}`,
    );
  };
  const dependencies = {
    ready: async (current) => ready[current.provider],
    persist: async () => {},
    sync: async () => "clean",
    run: async (current, prompt, session, save) => {
      const id = /verified owner Discord thread (\d+),/.exec(prompt)?.[1];
      assert(id && names.has(id), "Demo must use its own synthetic thread.");
      const number = ++nextSession;
      const created =
        current.provider === "opencode"
          ? `ses_${String(number).padStart(26, "9")}`
          : `90000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
      const observed = session ?? created;
      save(observed);
      runs.push({
        thread: id,
        provider: current.provider,
        resumed: session,
        observed,
      });
      const response = scripted.shift() ?? {
        ok: true,
        output: `[synthetic] ${label(current.provider)} finished this demo task.`,
      };
      return {
        ...response,
        error: response.ok ? null : "synthetic_uncertain_result",
        sessionId: observed,
      };
    },
  };
  const transport = {
    send: async (id, text) => transcript.push({ id, text }),
    typing: async () => {},
  };
  async function select(provider) {
    if (engine) {
      engine.stop();
      await engine.kick();
    }
    engine = new Engine(
      { ...config, provider },
      store,
      transport,
      dependencies,
    );
    await engine.kick();
  }
  async function send(id, name, content, response) {
    names.set(id, name);
    const messageId = String(940000000000000000n + BigInt(++nextMessage));
    if (response) scripted.push(response);
    line("owner", `${name} > ${content}`);
    const start = transcript.length;
    const accepted = await engine.accept({
      ...identity,
      id: messageId,
      authorId: identity.ownerId,
      guildId: identity.guildId,
      parentId: identity.parentId,
      channelId: id,
      bot: false,
      webhook: false,
      thread: true,
      content,
      attachments: 0,
    });
    assert.equal(accepted, true);
    await engine.kick();
    const delivered = transcript.slice(start);
    for (const item of delivered) {
      if (item.text.startsWith("[synthetic]"))
        line("agent", `${names.get(item.id)} < ${item.text}`);
      if (item.text.startsWith("Manual recovery queued."))
        line(
          "engine",
          "Manual recovery queued. Inspect prior state and receipts first.",
        );
    }
    return { messageId, delivered };
  }
  try {
    for (const path of [
      "workspace/agent/memory",
      "workspace/agent/conversations",
      "state",
      "artifacts",
      "browser",
      "codex",
    ])
      await mkdir(join(root, path), { recursive: true, mode: 0o700 });
    for (const name of ["SOUL", "USER", "MEMORY", "POLICY"])
      await writeFile(
        join(config.workspace, `agent/${name}.md`),
        `# Synthetic offline demo ${name}\n`,
        { mode: 0o600 },
      );
    store = new Store(join(config.stateDir, "demo.sqlite"));
    await select("codex");
    if (mode === "session") {
      write("SESSION CONTINUITY");
      const first = await send(
        thread(1),
        "#feature",
        "Plan one focused change.",
        { ok: true, output: "[synthetic] Plan saved: one focused change." },
      );
      const saved = store.session(thread(1));
      state("#feature", thread(1), first.messageId);
      const second = await send(
        thread(1),
        "#feature",
        "Continue with that plan.",
        {
          ok: true,
          output: "[synthetic] Continuing the saved thread session.",
        },
      );
      state("#feature", thread(1), second.messageId);
      const sameSession =
        runs[1].resumed === saved && store.session(thread(1)) === saved;
      line(
        "evidence",
        `Follow-up received the exact saved session: ${sameSession}`,
      );
      const separate = await send(
        thread(2),
        "#another-task",
        "Start an unrelated task.",
        { ok: true, output: "[synthetic] This task has its own session." },
      );
      state("#another-task", thread(2), separate.messageId);
      const separateSession =
        runs[2].resumed === null && store.session(thread(2)) !== saved;
      line(
        "evidence",
        `Different thread owns a separate session: ${separateSession}`,
      );
      assert(sameSession && separateSession);
      return { sameSession, separateSession, runs: runs.length };
    }
    if (mode === "recovery") {
      write("EXPLICIT RECOVERY");
      const failed = await send(
        thread(1),
        "#release",
        "Prepare a release note.",
        {
          ok: false,
          output:
            "[synthetic] Uncertain result; no external action was performed.",
        },
      );
      state("#release", thread(1), failed.messageId);
      const followup = await send(
        thread(1),
        "#release",
        "Continue preparing the note.",
      );
      state("#release", thread(1), followup.messageId);
      const status = await send(thread(1), "#release", "!status");
      for (const item of status.delivered)
        for (const text of item.text
          .split("\n")
          .filter((value) =>
            /^(Thread:|Queue in this thread:|Worker:)/.test(value),
          ))
          line("status", text);
      const before = runs.length;
      await engine.kick();
      const noReplay = before === 1 && runs.length === before;
      line("evidence", `No replay before an explicit recovery: ${noReplay}`);
      const recovery = await send(
        thread(1),
        "#release",
        `!recover ${failed.messageId}`,
        {
          ok: true,
          output: "[synthetic] Prior demo state inspected; note is ready.",
        },
      );
      state("#release", thread(1), recovery.messageId);
      const cancelledFollowup =
        store.get(followup.messageId).status === "cancelled";
      const recovered =
        store.get(recovery.messageId).recovery_of === failed.messageId &&
        store.get(recovery.messageId).status === "succeeded";
      line(
        "evidence",
        `Recovery recorded; stale follow-up cancelled: ${recovered && cancelledFollowup}`,
      );
      assert(noReplay && recovered && cancelledFollowup);
      return { noReplay, recovered, cancelledFollowup, runs: runs.length };
    }
    write("PROVIDER-BOUND THREADS");
    const first = await send(thread(1), "#existing", "Start a Codex task.");
    const saved = store.session(thread(1));
    state("#existing", thread(1), first.messageId);
    ready.claude = false;
    await select("claude");
    line(
      "config",
      "New-thread default = Claude Code; its local readiness is scripted unavailable.",
    );
    const waiting = await send(
      thread(2),
      "#new-claude",
      "Use the configured default.",
    );
    state("#new-claude", thread(2), waiting.messageId);
    const continued = await send(
      thread(1),
      "#existing",
      "Continue after the default changed.",
    );
    state("#existing", thread(1), continued.messageId);
    const bindingRetained =
      store.get(continued.messageId).provider === "codex" &&
      store.session(thread(1)) === saved;
    const otherProviderRan =
      store.get(waiting.messageId).status === "queued" &&
      store.get(continued.messageId).status === "succeeded";
    line(
      "evidence",
      `Existing Codex binding retained; ready work ran while Claude waited: ${bindingRetained && otherProviderRan}`,
    );
    await select("opencode");
    line(
      "config",
      "New-thread default = OpenCode; its local readiness is scripted available.",
    );
    const open = await send(
      thread(3),
      "#new-opencode",
      "Use OpenCode for this thread.",
    );
    state("#new-opencode", thread(3), open.messageId);
    const openBound = store.get(open.messageId).provider === "opencode";
    ready.claude = true;
    line("config", "Claude Code local readiness is now scripted available.");
    const start = transcript.length;
    await engine.kick();
    for (const item of transcript.slice(start))
      if (item.text.startsWith("[synthetic]"))
        line("agent", `${names.get(item.id)} < ${item.text}`);
    state("#new-claude", thread(2), waiting.messageId);
    const waitingFinished = store.get(waiting.messageId).status === "succeeded";
    line(
      "evidence",
      `Waiting task resumed on its original runner: ${waitingFinished && store.get(waiting.messageId).provider === "claude"}`,
    );
    assert(bindingRetained && otherProviderRan && openBound && waitingFinished);
    return {
      bindingRetained,
      otherProviderRan,
      openBound,
      waitingFinished,
      runs: runs.length,
    };
  } finally {
    if (engine) {
      engine.stop();
      await engine.kick();
    }
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Real Engine/SQLite state transitions; transport, readiness and agent replies are scripted. */
export async function runDemo(mode = "all", write = console.log) {
  if (mode !== "all" && !modes.includes(mode))
    throw new Error(
      "Usage: node scripts/demo.mjs [session|recovery|providers]",
    );
  write("Offline demo · synthetic data · no model calls");
  write(
    "Real Engine + SQLite Store; transport, readiness and agent replies are scripted.",
  );
  const result = {};
  for (const selected of mode === "all" ? modes : [mode]) {
    write("");
    result[selected] = await scenario(selected, write);
  }
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error("Usage: node scripts/demo.mjs [session|recovery|providers]");
    process.exitCode = 1;
  } else
    try {
      await runDemo(args[0] ?? "all");
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "Offline demo failed.",
      );
      process.exitCode = 1;
    }
}
