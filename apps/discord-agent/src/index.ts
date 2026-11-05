import { mkdir, chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, runnerHome } from "./config.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { DiscordTransport } from "./discord.js";
async function main(): Promise<void> {
  const config = loadConfig();
  // The token remains only in the transport's memory and never enters child envs.
  delete process.env.DISCORD_BOT_TOKEN;
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
  const store = new Store(join(config.stateDir, "agent.sqlite"));
  const recovered = store.recoverStartup();
  const transport = new DiscordTransport(config),
    engine = new Engine(config, store, transport);
  let ready = false;
  transport.onMessage((message) =>
    ready ? engine.accept(message) : Promise.resolve(false),
  );
  try {
    await transport.connect();
  } catch (error) {
    transport.close();
    store.close();
    throw error;
  }
  ready = true;
  console.log(JSON.stringify({ event: "ready", interruptedJobs: recovered }));
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
    while (engine.isBusy())
      await new Promise((resolve) => setTimeout(resolve, 100));
    transport.close();
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
