import type { JobStatus, Store } from "./store.js";

interface ConversationState {
  blocked_reason: string | null;
  has_session: number;
}
interface Counts {
  queued: number;
  running: number;
  recovering: number;
}
interface RecentTask {
  id: string;
  status: JobStatus;
  notification: string;
}

export const COMMAND_HELP = [
  "Send a normal message to queue a task in this thread.",
  "!status — show this thread's queue, worker and recovery state.",
  "!result [task ID] — read the saved response (latest task by default).",
  "!cancel <task ID> — cancel a queued task or stop this thread's active process.",
  "!recover <task ID> — inspect prior actions and continue a failed or interrupted task; replaces queued follow-ups in this thread.",
  "!new-session — clear this thread's session and cancel its queued tasks; history is retained.",
  "!help — show these commands.",
  "One worker runs tasks across all threads. A queued task is not running yet. Stopping a process does not undo actions already taken.",
].join("\n");

/** Read only operational metadata; never include prompts, replies or session IDs. */
export function threadStatus(
  store: Store,
  threadId: string,
  authReady: boolean,
): string {
  const conversation = store.db
    .prepare(
      "SELECT blocked_reason,session_id IS NOT NULL AS has_session FROM conversations WHERE thread_id=?",
    )
    .get(threadId) as ConversationState | undefined;
  const counts = store.db
    .prepare(
      `SELECT COALESCE(SUM(status='queued'),0) queued,
        COALESCE(SUM(status='running'),0) running,
        COALESCE(SUM(status IN('queued','running') AND recovery_of IS NOT NULL),0) recovering
        FROM jobs WHERE thread_id=?`,
    )
    .get(threadId) as unknown as Counts;
  const occupied = Boolean(
    store.db.prepare("SELECT 1 FROM jobs WHERE status='running' LIMIT 1").get(),
  );
  const recent = store.db
    .prepare(
      "SELECT id,status,notification FROM jobs WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 8",
    )
    .all(threadId) as unknown as RecentTask[];
  const uncertain = store.db
    .prepare(
      "SELECT id FROM jobs WHERE thread_id=? AND notification='ambiguous' ORDER BY finished_at DESC,id DESC LIMIT 1",
    )
    .get(threadId) as { id: string } | undefined;
  const blocked = conversation?.blocked_reason;
  const lines = [
    authReady
      ? "Codex: authenticated."
      : "Codex: login unverified; queued work waits until authentication is confirmed.",
    blocked
      ? blocked === "failed" || blocked === "interrupted"
        ? `Thread: blocked after ${blocked === "interrupted" ? "an interrupted" : "a failed"} task. Queued messages cannot run until you choose recovery or a new session.`
        : "Thread: blocked; owner action is required before queued messages can run."
      : "Thread: not blocked.",
    `Session: ${conversation?.has_session ? "saved for this thread" : "not started"}.`,
    `Queue in this thread: ${counts.queued} queued; ${counts.running} running.`,
    occupied
      ? counts.running > 0
        ? "Worker: running a task in this thread."
        : "Worker: busy in another thread. This thread's queued tasks are waiting."
      : "Worker: idle. Queued tasks have not started yet.",
    "Recent tasks:",
    ...(recent.length
      ? recent.map(
          (job) =>
            `${job.id}: ${job.status}${job.notification === "ambiguous" ? " (response delivery uncertain)" : ""}`,
        )
      : ["No tasks in this thread."]),
  ];
  if (uncertain)
    lines.push(
      `Response delivery is uncertain for task ${uncertain.id}. Use !result ${uncertain.id} to read its saved response; do not repeat the task just to resend a response.`,
    );
  if (counts.recovering > 0)
    lines.push(
      "Next: a manual recovery is already queued or running in this thread. Wait for its result; do not queue another recovery.",
    );
  else if (blocked && counts.running === 0) {
    // Resolve all ancestors of a successful recovery, including multi-step chains.
    const recoverable = store.db
      .prepare(
        `WITH RECURSIVE resolved(id) AS (
          SELECT recovery_of FROM jobs WHERE thread_id=? AND status='succeeded' AND recovery_of IS NOT NULL
          UNION
          SELECT j.recovery_of FROM jobs j JOIN resolved r ON j.id=r.id
            WHERE j.thread_id=? AND j.recovery_of IS NOT NULL
        ) SELECT id FROM jobs WHERE thread_id=? AND status IN('failed','interrupted')
          AND id NOT IN(SELECT id FROM resolved)
          ORDER BY created_at DESC,id DESC LIMIT 1`,
      )
      .get(threadId, threadId, threadId) as { id: string } | undefined;
    lines.push(
      recoverable
        ? `Next: use !recover ${recoverable.id} to inspect prior actions and continue. Recovery replaces queued follow-ups in this thread. Use !new-session instead to cancel queued work and start fresh; history is retained.`
        : "Next: use !new-session to clear this thread's block and start fresh. This cancels queued work; history is retained. No failed or interrupted task is eligible for recovery.",
    );
  } else if (counts.running > 0)
    lines.push(
      "Next: wait for the current task or use !cancel <task ID> to stop it.",
    );
  else if (!authReady && counts.queued > 0)
    lines.push(
      "Next: complete Codex login on the host. These tasks remain saved in the queue.",
    );
  else if (counts.queued > 0)
    lines.push(
      "Next: wait for the worker to claim this thread's queued tasks.",
    );
  else lines.push("Next: send a normal message to queue a task, or use !help.");
  return lines.join("\n");
}
