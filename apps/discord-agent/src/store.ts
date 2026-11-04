import { DatabaseSync } from "node:sqlite";
import { SESSION_ID, SNOWFLAKE } from "./config.js";
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";
export interface Job {
  id: string;
  thread_id: string;
  prompt: string;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  error_code: string | null;
  notification: string;
  recovery_of: string | null;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(thread_id TEXT PRIMARY KEY,session_id TEXT UNIQUE,blocked_reason TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES conversations(thread_id),prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN('queued','running','succeeded','failed','interrupted','cancelled')),created_at INTEGER NOT NULL,
        started_at INTEGER,finished_at INTEGER,result TEXT,error_code TEXT,notification TEXT NOT NULL DEFAULT 'pending',recovery_of TEXT);
      CREATE INDEX IF NOT EXISTS job_status ON jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS controls(message_id TEXT PRIMARY KEY);
    `);
  }
  close(): void {
    this.db.close();
  }
  recoverStartup(): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        "UPDATE conversations SET blocked_reason='interrupted' WHERE thread_id IN(SELECT thread_id FROM jobs WHERE status='running')",
      );
      const count = Number(
        this.db
          .prepare(
            "UPDATE jobs SET status='interrupted',error_code='process_restarted',finished_at=? WHERE status='running'",
          )
          .run(Date.now()).changes,
      );
      this.db.exec(
        "UPDATE jobs SET notification='ambiguous' WHERE notification='sending'; COMMIT",
      );
      return count;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  controlOnce(id: string): boolean {
    return (
      Number(
        this.db.prepare("INSERT OR IGNORE INTO controls VALUES(?)").run(id)
          .changes,
      ) === 1
    );
  }
  enqueue(
    id: string,
    threadId: string,
    prompt: string,
    recoveryOf: string | null = null,
  ): boolean {
    if (!SNOWFLAKE.test(id) || !SNOWFLAKE.test(threadId))
      throw new Error("Invalid queue identity");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.get(id)) {
        this.db.exec("COMMIT");
        return false;
      }
      const counts = this.db
        .prepare(
          "SELECT COUNT(*) n,SUM(CASE WHEN thread_id=? THEN 1 ELSE 0 END) t FROM jobs WHERE status IN('queued','running')",
        )
        .get(threadId) as { n: number; t: number | null };
      if (counts.n >= 30 || (counts.t ?? 0) >= 8)
        throw new Error("Queue is full");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO conversations(thread_id,created_at) VALUES(?,?)",
        )
        .run(threadId, Date.now());
      this.db
        .prepare(
          "INSERT INTO jobs(id,thread_id,prompt,status,created_at,recovery_of) VALUES(?,?,?,'queued',?,?)",
        )
        .run(id, threadId, prompt, Date.now(), recoveryOf);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(id: string): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
      | Job
      | undefined;
  }
  session(threadId: string): string | null {
    return (
      (
        this.db
          .prepare("SELECT session_id FROM conversations WHERE thread_id=?")
          .get(threadId) as { session_id: string | null } | undefined
      )?.session_id ?? null
    );
  }
  setSession(threadId: string, sessionId: string): void {
    if (!SESSION_ID.test(sessionId))
      throw new Error("Invalid Codex session ID");
    const old = this.session(threadId);
    if (old && old !== sessionId)
      throw new Error("Codex session changed unexpectedly");
    this.db
      .prepare("UPDATE conversations SET session_id=? WHERE thread_id=?")
      .run(sessionId, threadId);
  }
  claim(): Job | undefined {
    return this.db
      .prepare(
        `UPDATE jobs SET status='running',started_at=? WHERE id=(SELECT j.id FROM jobs j JOIN conversations c ON c.thread_id=j.thread_id
      WHERE j.status='queued' AND c.blocked_reason IS NULL ORDER BY j.created_at,j.id LIMIT 1)
      AND status='queued' AND NOT EXISTS(SELECT 1 FROM jobs WHERE status='running') RETURNING *`,
      )
      .get(Date.now()) as Job | undefined;
  }
  finish(
    id: string,
    status: "succeeded" | "failed" | "interrupted",
    result: string,
    error: string | null = null,
  ): void {
    const changed = this.db
      .prepare(
        "UPDATE jobs SET status=?,result=?,error_code=?,finished_at=? WHERE id=? AND status='running'",
      )
      .run(status, result, error, Date.now(), id);
    if (Number(changed.changes) !== 1) throw new Error("Job ownership lost");
    if (status !== "succeeded")
      this.db
        .prepare(
          "UPDATE conversations SET blocked_reason=? WHERE thread_id=(SELECT thread_id FROM jobs WHERE id=?)",
        )
        .run(status, id);
  }
  recover(id: string, threadId: string, newId: string): boolean {
    const old = this.get(id);
    if (
      !old ||
      old.thread_id !== threadId ||
      !["interrupted", "failed"].includes(old.status)
    )
      throw new Error(
        "Only an interrupted/failed job in this thread can be recovered",
      );
    const created = this.enqueue(
      newId,
      threadId,
      `Manual recovery of message ${id}. The previous turn may have changed files or published content. Inspect the saved session, transcript, journal and external publication receipts before taking any action. Never blindly repeat a publication. Original request:\n\n${old.prompt}`,
      id,
    );
    if (created) {
      this.db
        .prepare(
          "UPDATE jobs SET status='cancelled',error_code='superseded_by_recovery',finished_at=? WHERE thread_id=? AND status='queued' AND id<>?",
        )
        .run(Date.now(), threadId, newId);
      this.db
        .prepare(
          "UPDATE conversations SET blocked_reason=NULL WHERE thread_id=?",
        )
        .run(threadId);
    }
    return created;
  }
  resetSession(threadId: string): void {
    const running = this.db
      .prepare("SELECT id FROM jobs WHERE thread_id=? AND status='running'")
      .get(threadId);
    if (running) throw new Error("A turn is still running");
    this.db
      .prepare(
        "UPDATE jobs SET status='cancelled',error_code='owner_started_new_session',finished_at=? WHERE thread_id=? AND status='queued'",
      )
      .run(Date.now(), threadId);
    this.db
      .prepare(
        "UPDATE conversations SET session_id=NULL,blocked_reason=NULL WHERE thread_id=?",
      )
      .run(threadId);
  }
  cancel(id: string, threadId: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE jobs SET status='cancelled',error_code='owner_cancelled',finished_at=? WHERE id=? AND thread_id=? AND status='queued'",
          )
          .run(Date.now(), id, threadId).changes,
      ) === 1
    );
  }
  recent(threadId: string): Job[] {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 8",
      )
      .all(threadId) as unknown as Job[];
  }
  pendingNotification(): Job | undefined {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN('succeeded','failed','interrupted') AND notification='pending' ORDER BY finished_at,id LIMIT 1",
      )
      .get() as Job | undefined;
  }
  notification(id: string, state: "sending" | "sent" | "ambiguous"): void {
    this.db.prepare("UPDATE jobs SET notification=? WHERE id=?").run(state, id);
  }
}
