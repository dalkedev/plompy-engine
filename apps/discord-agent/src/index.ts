import { mkdir, chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, runnerHome } from "./config.js";
import { cleanupStaleImages } from "./images.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { DiscordTransport } from "./discord.js";
import { assertSupportedRuntime } from "./node-runtime.js";
import { loadAssistantSettings, PersonalAssistant } from "./assistant.js";
import { AssistantStore } from "./assistant-store.js";
import { ReminderScheduler } from "./assistant-delivery.js";
async function main(): Promise<void> {
  assertSupportedRuntime();
  const config = loadConfig();
  const assistantSettings = loadAssistantSettings();
  // The token remains only in the transport's memory and never enters child envs.
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.PLOMPY_GIT_SSH_COMMAND;
  delete process.env.SZPONT_GIT_SSH_COMMAND;
  for (const path of [
    config.stateDir,
    config.artifactsDir,
    runnerHome(config),
    config.browserDir,
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  await realpath(config.workspace);
  await cleanupStaleImages(config.stateDir);
  const store = new Store(join(config.stateDir, "agent.sqlite"));
  const transport = new DiscordTransport(config, assistantSettings?.threadId),
    engine = new Engine(config, store, transport);
  let ready = false;
  let assistantStore: AssistantStore | undefined;
  let assistant: PersonalAssistant | undefined;
  let scheduler: ReminderScheduler | undefined;
  const reportAssistantFailure = () =>
    console.error(
      JSON.stringify({ event: "assistant_delivery", status: "error" }),
    );
  transport.onMessage(async (message) => {
    if (!ready) return false;
    if (assistant && (await assistant.handle(message))) return true;
    return engine.accept(message);
  });
  let recovered: ReturnType<Store["recoverStartup"]>;
  try {
    recovered = store.recoverStartup();
    await transport.connect();
    if (assistantSettings) {
      await transport.thread(assistantSettings.threadId);
      assistantStore = new AssistantStore(
        join(config.stateDir, "assistant.sqlite"),
        {
          ownerId: config.ownerId,
          threadId: assistantSettings.threadId,
          zone: assistantSettings.zone,
        },
      );
      assistant = new PersonalAssistant(
        config,
        assistantSettings,
        assistantStore,
        transport,
      );
      scheduler = new ReminderScheduler(
        assistantStore,
        transport.sendReminder.bind(transport),
        {
          ...assistantSettings,
          onError: reportAssistantFailure,
        },
      );
      scheduler.start();
    }
  } catch (error) {
    transport.close();
    assistantStore?.close();
    store.close();
    throw error;
  }
  ready = true;
  console.log(
    JSON.stringify({
      event: "ready",
      interruptedJobs: recovered,
      assistant: !!assistant,
    }),
  );
  void engine.kick();
  const tick = setInterval(() => {
    void engine.kick();
  }, 30_000);
  let shutting = false;
  const shutdown = async (): Promise<void> => {
    if (shutting) return;
    shutting = true;
    ready = false;
    clearInterval(tick);
    engine.stop();
    await scheduler?.stop().catch(reportAssistantFailure);
    while (engine.isBusy())
      await new Promise((resolve) => setTimeout(resolve, 100));
    transport.close();
    assistantStore?.close();
    store.close();
  };
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
main().catch(() => {
  console.error(
    JSON.stringify({
      event: "startup",
      status: "failed",
      hint: "Check required paths, bot/forum identity, permissions, Node version and selected runner readiness.",
    }),
  );
  process.exitCode = 1;
});
