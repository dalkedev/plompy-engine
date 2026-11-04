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
import {
  parseWorkCommand,
  validateWorkOutcome,
  workflowPrompt,
} from "./workflow.js";
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
    options?: { workflow?: boolean },
  ) => Promise<TurnResult>;
  persist: (config: Config, store: Store, threadId: string) => Promise<void>;
  sync: (config: Config, id: string) => Promise<string>;
  now?: () => number;
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
  private completion: Promise<void> | undefined;
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
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  async accept(message: Incoming): Promise<boolean> {
    if (!authorized(message, this.config)) return false;
    const text = message.content.trim(),
      thread = message.channelId;
    if (/^!work(?:\s|$)/.test(text)) {
      if (!this.store.controlOnce(message.id)) return true;
      let request;
      try {
        request = parseWorkCommand(text);
      } catch {
        await this.notice(
          thread,
          "Usage: !work 30m <goal> or !work 2h <goal>. Use a budget from 1 minute to 2 hours and a nonempty goal. Nothing was queued.",
        );
        return true;
      }
      if (request) {
        let inserted;
        try {
          inserted = this.store.enqueueWorkflow(
            message.id,
            thread,
            redact(request.goal, this.config.token),
            request.budgetMs,
          );
        } catch {
          await this.notice(
            thread,
            "Cannot queue this work session. Use !status to check this thread and queue capacity. Nothing was queued.",
          );
          return true;
        }
        try {
          if (inserted)
            await this.notice(
              thread,
              `Work session queued: ${message.id}. Active execution budget: ${Math.round(request.budgetMs / 60_000)} min; at most 32 completed steps. Queue and maintenance wait do not use this budget.`,
            );
        } finally {
          void this.kick();
        }
        return true;
      }
    }
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
          await this.notice(
            thread,
            `Usage: ${usage}. Use !help for command syntax. No action was taken and nothing was queued.`,
          );
          return true;
        }
        let changed = false;
        try {
          if (command === "!status") {
            await this.notice(
              thread,
              threadStatus(this.store, thread, this.authReady),
            );
            return true;
          }
          if (command === "!help") {
            await this.notice(thread, COMMAND_HELP);
            return true;
          }
          if (command === "!cancel") {
            if (
              id &&
              this.active?.id === id &&
              this.active.thread_id === thread &&
              this.store.get(id)?.status === "running"
            ) {
              this.abort?.abort();
              await this.notice(
                thread,
                "Stopping the current process. Actions already taken may require reconciliation.",
              );
            } else {
              changed = Boolean(id && this.store.cancel(id, thread));
              await this.notice(
                thread,
                changed
                  ? "Queued task cancelled."
                  : "No queued task found in this thread.",
              );
            }
            return true;
          }
          if (command === "!new-session") {
            this.store.resetSession(thread);
            changed = true;
            await this.notice(
              thread,
              "The next message starts a new Codex session. History is retained; queued messages were cancelled.",
            );
            return true;
          }
          if (command === "!result") {
            const job = id ? this.store.get(id) : this.store.recent(thread)[0];
            await this.notice(
              thread,
              job && job.thread_id === thread
                ? `${job.id}: ${job.status}\n\n${job.result ?? "No saved response."}`
                : "Task not found.",
            );
            return true;
          }
          if (command === "!recover") {
            if (!id) throw new Error("missing ID");
            changed = this.store.recover(id, thread, message.id);
            await this.notice(
              thread,
              changed
                ? "Manual recovery queued. Codex will inspect prior state and action receipts first."
                : "This recovery request is already saved. Use !status for its state.",
            );
            return true;
          }
        } catch {
          await this.notice(
            thread,
            "Cannot perform this operation. Use !status for task IDs and state; only interrupted or failed tasks in this thread with remaining workflow budget can be recovered. For a paused work session, start a new explicit !work budget.",
          );
          return true;
        } finally {
          if (changed) void this.kick();
        }
      }
      if (this.store.controlOnce(message.id))
        await this.notice(
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
      await this.notice(
        thread,
        "Queue is full. Wait for current tasks to finish.",
      );
      return true;
    }
    try {
      if (inserted)
        await this.notice(
          thread,
          `Queued: ${message.id}.${this.authReady ? "" : " Codex login is unverified; this message remains in the durable queue."}`,
        );
    } finally {
      // Durable insertion is authoritative; failed notices/export cannot unqueue it.
      void this.kick();
    }
    return true;
  }
  private async send(thread: string, text: string): Promise<void> {
    await this.transport.send(thread, redact(text, this.config.token));
  }
  /** Progress notices are best effort, unlike final delivery receipts. */
  private async notice(thread: string, text: string): Promise<void> {
    try {
      await this.send(thread, text);
    } catch {
      console.log(
        JSON.stringify({ event: "progress_notice", status: "unavailable" }),
      );
    }
  }
  /** At most two due threads per pass; errors retry durably, never via Codex. */
  private async maintain(): Promise<void> {
    for (const effect of this.store.pendingEffects(this.now(), 2)) {
      const { thread_id: thread, generation } = effect;
      if (effect.exported_generation < generation) {
        try {
          await this.deps.persist(this.config, this.store, thread);
          this.store.completeEffect(thread, generation, "transcript");
        } catch {
          this.store.failEffect(
            thread,
            generation,
            "transcript_export_failed",
            this.now(),
          );
          continue;
        }
      }
      try {
        const label = this.store.recent(thread)[0]?.id ?? thread;
        const result = await this.deps.sync(this.config, label);
        if (result === "blocked") {
          this.store.failEffect(
            thread,
            generation,
            "memory_sync_blocked",
            this.now(),
          );
        } else if (result === "clean" || result === "committed") {
          this.store.completeEffect(thread, generation, "memory");
        } else {
          this.store.failEffect(
            thread,
            generation,
            "memory_sync_failed",
            this.now(),
          );
        }
      } catch {
        this.store.failEffect(
          thread,
          generation,
          "memory_sync_failed",
          this.now(),
        );
      }
    }
  }
  async kick(): Promise<void> {
    if (this.busy) return this.completion;
    if (this.stopping) return;
    this.busy = true;
    let complete!: () => void;
    this.completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    try {
      // Auth/inference availability is independent of readable history and Git sync.
      await this.maintain();
      await this.notify();
      this.authReady = await this.deps.ready(this.config).catch(() => false);
      if (!this.authReady) return;
      let job: Job | undefined;
      while (!this.stopping && (job = this.store.claim())) {
        this.active = job;
        this.abort = new AbortController();
        let typing: NodeJS.Timeout | undefined;
        let spent = 0;
        let started: number | undefined;
        let committed = false;
        try {
          await this.notice(job.thread_id, `Working on ${job.id}.`);
          const thread = job.thread_id;
          typing = setInterval(() => {
            void this.transport.typing(thread).catch(() => {});
          }, 8000);
          let prompt = await assemblePrompt(this.config, job);
          const workflow = this.store.workflow(job.id);
          const remaining = workflow
            ? workflow.budget_ms - workflow.elapsed_ms
            : this.config.timeoutMs;
          if (remaining <= 0) throw new Error("workflow budget invariant");
          if (workflow)
            prompt = workflowPrompt(prompt, {
              goal: workflow.goal,
              step: workflow.step_count + 1,
              remainingMs: remaining,
              lastSummary: workflow.last_summary,
              nextAction: workflow.next_action,
            });
          started = this.now();
          const result = await this.deps.run(
            workflow
              ? {
                  ...this.config,
                  timeoutMs: Math.max(
                    1,
                    Math.min(this.config.timeoutMs, remaining),
                  ),
                }
              : this.config,
            prompt,
            this.store.session(job.thread_id),
            (id) => this.store.setSession(job!.thread_id, id),
            this.abort.signal,
            workflow ? { workflow: true } : undefined,
          );
          spent = Math.max(1, this.now() - started);
          started = undefined;
          if (result.ok && workflow) {
            let outcome;
            try {
              outcome = validateWorkOutcome(
                redact(result.output, this.config.token),
              );
            } catch {
              this.store.finish(
                job.id,
                "interrupted",
                "",
                "invalid_workflow_output",
                spent,
              );
              committed = true;
            }
            if (outcome) {
              const checkpoint = this.store.checkpoint(job.id, outcome, spent);
              committed = true;
              if (checkpoint.continued)
                await this.notice(
                  job.thread_id,
                  `Work session ${job.id}: step ${workflow.step_count + 1} checkpoint saved. Continuing after other eligible threads.\n\n${outcome.summary}`,
                );
            }
          } else {
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
              spent,
            );
            committed = true;
          }
        } catch {
          if (started !== undefined) spent = Math.max(1, this.now() - started);
          // A failure after committing a checkpoint/finish must not overwrite it.
          if (!committed && this.store.get(job.id)?.status === "running")
            this.store.finish(
              job.id,
              "interrupted",
              "",
              "engine_turn_interrupted",
              spent,
            );
        } finally {
          if (typing) clearInterval(typing);
          this.abort = undefined;
          this.active = undefined;
        }
        await this.maintain();
        await this.notify();
        this.authReady = await this.deps.ready(this.config).catch(() => false);
        if (!this.authReady) break;
      }
    } catch {
      console.log(JSON.stringify({ event: "engine_tick", status: "blocked" }));
    } finally {
      this.busy = false;
      this.completion = undefined;
      complete();
    }
  }
  private async notify(): Promise<void> {
    let job: Job | undefined;
    while ((job = this.store.pendingNotification())) {
      this.store.notification(job.id, "sending");
      try {
        const workflow = this.store.workflow(job.id);
        const recovery =
          workflow &&
          (workflow.elapsed_ms >= workflow.budget_ms ||
            workflow.step_count >= workflow.max_steps)
            ? "This uncertain turn exhausted its work budget or step cap. Use !status and !result to inspect it. Choose !new-session explicitly before starting a fresh !work budget; history is retained."
            : `Use !recover ${job.id} to reconcile state and continue.`;
        const text =
          workflow?.state === "paused"
            ? `Work session ${job.id}: paused after a verified checkpoint (${job.error_code ?? "budget exhausted"}). The overall goal is not marked complete. This thread is not blocked; a fresh explicit !work 30m <goal> budget can continue its saved session.\n\n${job.result ?? ""}`
            : job.status === "succeeded"
              ? job.result || "Completed without a text response."
              : `Task ${job.id}: ${job.status} (${job.error_code ?? "unknown"}). Partial actions may have occurred. No automatic retry. ${recovery}\n\n${job.result ?? ""}`;
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
