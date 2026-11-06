import type { ProviderId } from "./config.js";
import { providerLabel } from "./status.js";
import type { QueueItem, Store } from "./store.js";

const reasons: Record<QueueItem["reason"], string> = {
  running: "running now",
  blocked_thread: "waiting for this thread's recovery",
  runner_mismatch: "runner binding mismatch; inspect the host configuration",
  earlier_task: "waiting behind an earlier accepted task in this thread",
  runner_unavailable:
    "runner readiness unverified; waiting for authentication or configuration",
  eligible: "eligible for the shared worker",
};

/** Metadata from this thread only. No model, readiness probe, or queue mutation. */
export function threadQueue(
  store: Store,
  threadId: string,
  authReady: boolean,
  provider: ProviderId = store.provider(threadId) ?? "codex",
): string {
  const { items, workerBusy } = store.queue(
    threadId,
    authReady ? [provider] : [],
  );
  const running = items.some((item) => item.status === "running");
  const blocker = store.blockingJob(threadId);
  const lines = [
    "Queue in this thread (accepted order):",
    ...items.map(
      (item) =>
        `${item.id}: ${item.status} — ${providerLabel(item.provider)}; ${reasons[item.reason]}.`,
    ),
    ...(items.length ? [] : ["No queued or running tasks in this thread."]),
    running
      ? "Worker: running a task in this thread."
      : workerBusy
        ? "Worker: busy in another thread."
        : "Worker: idle; no task is running.",
    "This is a snapshot, not an ETA or a global queue rank. Work sessions yield between verified checkpoints; accepted order within this thread is retained.",
  ];
  if (blocker) {
    const workflow = store.workflow(blocker.id);
    lines.push(
      workflow &&
        (workflow.elapsed_ms >= workflow.budget_ms ||
          workflow.step_count >= workflow.max_steps)
        ? `Next: inspect !status and !result ${blocker.id}, then use !work 30m <goal> to authorize a fresh budget and reconcile prior actions.`
        : `Next: inspect !status and !result ${blocker.id}, then use !recover ${blocker.id} [instruction] to reconcile prior actions and continue.`,
    );
  } else if (items.some((item) => item.reason === "blocked_thread")) {
    lines.push(
      "Next: use !status to inspect this thread's block before choosing recovery or a new session.",
    );
  } else if (running) {
    lines.push(
      "Next: wait for the current task or use !cancel <task ID> to stop it. Stopping does not undo prior actions.",
    );
  } else if (items.some((item) => item.reason === "runner_mismatch")) {
    lines.push(
      "Next: inspect runner bindings on the host; do not switch this thread's saved runner or repeat the task.",
    );
  } else if (items.some((item) => item.reason === "runner_unavailable")) {
    lines.push(
      `Next: verify ${providerLabel(provider)} login and configuration on the host. Readiness reflects the worker's last check; !queue does not contact the runner.${provider === "opencode" ? " OpenCode remote authentication remains untested." : ""}`,
    );
  } else if (items.length) {
    lines.push(
      "Next: wait for the worker to claim an eligible task. A queued task has not started yet.",
    );
  } else {
    lines.push(
      "Next: send a normal message or !work 30m <goal> to queue a task; !result reads a saved response.",
    );
  }
  return lines.join("\n");
}
