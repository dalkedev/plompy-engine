import {
  authorized,
  redact,
  SNOWFLAKE,
  type Config,
  type Incoming,
} from "./config.js";
import { assemblePrompt, saveTranscript, syncMemory } from "./workspace.js";
import { loginReady, runCodex, type TurnResult } from "./codex.js";
import { Store, type Job } from "./store.js";
import { COMMAND_HELP, threadStatus } from "./status.js";
export interface Transport {
  send(threadId: string, text: string): Promise<void>;
  typing(threadId: string): Promise<void>;
}
export interface Dependencies {
  ready: (config: Config) => Promise<boolean>;
  run: (
    config: Config,
    prompt: string,
    session: string | null,
    onSession: (id: string) => void,
    signal: AbortSignal,
  ) => Promise<TurnResult>;
  persist: (config: Config, store: Store, threadId: string) => Promise<void>;
  sync: (config: Config, id: string) => Promise<string>;
}
const defaults: Dependencies = {
  ready: loginReady,
  run: runCodex,
  persist: saveTranscript,
  sync: syncMemory,
};
const commandUsage = new Map([
  ["!status", "!status"],
  ["!help", "!help"],
  ["!cancel", "!cancel <task ID>"],
  ["!recover", "!recover <task ID>"],
  ["!new-session", "!new-session"],
  ["!result", "!result [task ID]"],
]);
export class Engine {
  private busy = false;
  private stopping = false;
  private active: Job | undefined;
  private abort: AbortController | undefined;
  authReady = false;
  constructor(
    readonly config: Config,
    readonly store: Store,
    private transport: Transport,
    private deps: Dependencies = defaults,
  ) {}
  async accept(message: Incoming): Promise<boolean> {
    if (!authorized(message, this.config)) return false;
    const text = message.content.trim(),
      thread = message.channelId;
    if (text.startsWith("!")) {
      const [command, id, ...extra] = text.split(/\s+/);
      const usage = commandUsage.get(command ?? "");
      if (usage) {
        if (!this.store.controlOnce(message.id)) return true;
        const requiresId = command === "!cancel" || command === "!recover";
        const acceptsId = requiresId || command === "!result";
        const validArguments =
          extra.length === 0 &&
          (acceptsId
            ? id
              ? SNOWFLAKE.test(id)
              : !requiresId
            : id === undefined);
        if (!validArguments) {
          await this.send(
            thread,
            `Usage: ${usage}. Use !help for command syntax. No action was taken and nothing was queued.`,
          );
          return true;
        }
        try {
          if (command === "!status") {
            await this.send(
              thread,
              threadStatus(this.store, thread, this.authReady),
            );
            return true;
          }
          if (command === "!help") {
            await this.send(thread, COMMAND_HELP);
            return true;
          }
          if (command === "!cancel") {
            if (
              id &&
              this.active?.id === id &&
              this.active.thread_id === thread
            ) {
              this.abort?.abort();
              await this.send(
                thread,
                "Stopping the current process. Actions already taken may require reconciliation.",
              );
            } else
              await this.send(
                thread,
                id && this.store.cancel(id, thread)
                  ? "Queued task cancelled."
                  : "No queued task found in this thread.",
              );
            return true;
          }
          if (command === "!new-session") {
            this.store.resetSession(thread);
            await this.send(
              thread,
              "The next message starts a new Codex session. History is retained; queued messages were cancelled.",
            );
            return true;
          }
          if (command === "!result") {
            const job = id ? this.store.get(id) : this.store.recent(thread)[0];
            await this.send(
              thread,
              job && job.thread_id === thread
                ? `${job.id}: ${job.status}\n\n${job.result ?? "No saved response."}`
                : "Task not found.",
            );
            return true;
          }
          if (command === "!recover") {
            if (!id) throw new Error("missing ID");
            this.store.recover(id, thread, message.id);
            await this.deps.persist(this.config, this.store, thread);
            await this.send(
              thread,
              "Manual recovery queued. Codex will inspect prior state and action receipts first.",
            );
            void this.kick();
            return true;
          }
        } catch {
          await this.send(
            thread,
            "Cannot perform this operation. Use !status for task IDs and state; only interrupted or failed tasks in this thread can be recovered.",
          );
          return true;
        }
      }
      if (this.store.controlOnce(message.id))
        await this.send(
          thread,
          "Unknown command. Use !help for command syntax. Nothing was queued.",
        );
      return true;
    }
    const prompt = redact(message.content, this.config.token);
    let inserted: boolean;
    try {
      inserted = this.store.enqueue(message.id, thread, prompt);
    } catch {
      await this.send(
        thread,
        "Queue is full. Wait for current tasks to finish.",
      );
      return true;
    }
    if (inserted) {
      await this.deps.persist(this.config, this.store, thread);
      await this.send(
        thread,
        `Queued: ${message.id}.${this.authReady ? "" : " Codex login is unverified; this message remains in the durable queue."}`,
      );
    }
    void this.kick();
    return true;
  }
  private async send(thread: string, text: string): Promise<void> {
    await this.transport.send(thread, redact(text, this.config.token));
  }
  async kick(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      this.authReady = await this.deps.ready(this.config);
      // Notifications are independent of auth and must not restart Codex work.
      await this.notify();
      if (!this.authReady) return;
      let job: Job | undefined;
      while (!this.stopping && (job = this.store.claim())) {
        this.active = job;
        this.abort = new AbortController();
        let typing: NodeJS.Timeout | undefined;
        try {
          await this.send(job.thread_id, `Working on ${job.id}.`);
          typing = setInterval(() => {
            void this.transport.typing(job!.thread_id).catch(() => {});
          }, 8000);
          const prompt = await assemblePrompt(this.config, job);
          const result = await this.deps.run(
            this.config,
            prompt,
            this.store.session(job.thread_id),
            (id) => this.store.setSession(job!.thread_id, id),
            this.abort.signal,
          );
          this.store.finish(
            job.id,
            result.ok
              ? "succeeded"
              : result.error === "task_timeout" ||
                  result.error === "owner_or_service_cancelled"
                ? "interrupted"
                : "failed",
            redact(result.output, this.config.token),
            result.error,
          );
        } catch {
          this.store.finish(
            job.id,
            "interrupted",
            "",
            "engine_turn_interrupted",
          );
        } finally {
          if (typing) clearInterval(typing);
          this.abort = undefined;
          this.active = undefined;
        }
        await this.deps.persist(this.config, this.store, job.thread_id);
        // Persistence/push failures are separate from whether the actual task succeeded.
        try {
          const sync = await this.deps.sync(this.config, job.id);
          console.log(
            JSON.stringify({ event: "memory_sync", job: job.id, status: sync }),
          );
        } catch {
          console.log(
            JSON.stringify({
              event: "memory_sync",
              job: job.id,
              status: "pending",
            }),
          );
        }
        await this.notify();
        this.authReady = await this.deps.ready(this.config);
        if (!this.authReady) break;
      }
    } catch {
      console.log(JSON.stringify({ event: "engine_tick", status: "blocked" }));
    } finally {
      this.busy = false;
    }
  }
  private async notify(): Promise<void> {
    let job: Job | undefined;
    while ((job = this.store.pendingNotification())) {
      this.store.notification(job.id, "sending");
      try {
        const text =
          job.status === "succeeded"
            ? job.result || "Completed without a text response."
            : `Task ${job.id}: ${job.status} (${job.error_code ?? "unknown"}). Partial actions may have occurred. No automatic retry. Use !recover ${job.id} to reconcile state and continue.\n\n${job.result ?? ""}`;
        await this.send(job.thread_id, text);
        this.store.notification(job.id, "sent");
      } catch {
        this.store.notification(job.id, "ambiguous");
      }
    }
  }
  stop(): void {
    this.stopping = true;
    this.abort?.abort();
  }
  isBusy(): boolean {
    return this.busy;
  }
}
