import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  resolveAssistantTime,
  type AssistantIntent,
} from "./assistant-intent.js";

export const ASSISTANT_SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x504c4f41; // PLOA
const LIST_LIMIT = 12;
const MAX_TEXT_LENGTH = 500;
const MAX_PENDING_ITEMS = 100;
const CLAIM_LEASE_MS = 30_000;
const DISPATCH_LEASE_MS = 120_000;

interface AssistantScope {
  ownerId: string;
  threadId: string;
  zone: string;
}

export interface NoteRecord {
  id: string;
  text: string;
  createdAt: number;
}

export interface TaskRecord extends NoteRecord {
  status: "open" | "done";
  dueAt: number | null;
}

export type ReminderStatus =
  | "scheduled"
  | "claimed"
  | "sending"
  | "retry"
  | "sent"
  | "failed"
  | "ambiguous"
  | "expired"
  | "cancelled";

export interface ReminderRecord extends NoteRecord {
  status: ReminderStatus;
  dueAt: number;
  zone: string;
  version: number;
}

export interface QuestionRecord {
  id: string;
  text: string;
  date: string | null;
  zone: string;
  targetId: string | null;
  status: "open" | "resolved" | "cancelled";
  createdAt: number;
}

type PendingQuestion = QuestionRecord & { targetVersion: number | null };

export type AssistantResult =
  | {
      kind:
        | "note_saved"
        | "task_added"
        | "task_done"
        | "reminder_cancelled"
        | "question_cancelled";
      id: string;
    }
  | { kind: "notes"; items: NoteRecord[] }
  | { kind: "tasks"; items: TaskRecord[] }
  | { kind: "reminder_saved"; item: ReminderRecord }
  | { kind: "reminders"; items: ReminderRecord[] }
  | { kind: "question_created"; item: QuestionRecord }
  | { kind: "questions"; items: QuestionRecord[] }
  | {
      kind: "problem";
      code:
        | "not_found"
        | "conflict"
        | "invalid_time"
        | "no_question"
        | "multiple_questions"
        | "multiple_tasks"
        | "multiple_reminders"
        | "invalid"
        | "capacity";
    };

export interface DeliveryClaim {
  id: string;
  version: number;
  token: string;
  text: string;
  dueAt: number;
  zone: string;
  attempt: number;
}

export type DeliveryOutcome =
  | { kind: "sent"; messageId: string }
  | { kind: "retry"; retryAt: number }
  | { kind: "failed" }
  | { kind: "ambiguous" };

const schema = `
  CREATE TABLE assistant_scope (
    singleton INTEGER PRIMARY KEY CHECK (singleton=1),
    owner_id TEXT NOT NULL, thread_id TEXT NOT NULL
  ) STRICT;
  CREATE TABLE assistant_operations (
    message_id TEXT PRIMARY KEY,
    accepted_at INTEGER NOT NULL,
    result_kind TEXT NOT NULL
  ) STRICT;
  CREATE TABLE assistant_notes (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    searchable_text TEXT NOT NULL,
    source_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE assistant_tasks (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    source_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  ) STRICT;
  CREATE TABLE assistant_reminders (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    source_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    zone TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
  ) STRICT;
  CREATE TABLE assistant_outbox (
    reminder_id INTEGER NOT NULL REFERENCES assistant_reminders(id),
    version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
      'scheduled','claimed','sending','retry','sent','failed','ambiguous','expired','cancelled'
    )),
    next_attempt_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    token TEXT,
    lease_until INTEGER,
    message_id TEXT,
    finished_at INTEGER,
    PRIMARY KEY(reminder_id, version)
  ) STRICT;
  CREATE INDEX assistant_due ON assistant_outbox(state, next_attempt_at);
  CREATE INDEX assistant_leases ON assistant_outbox(state, lease_until);
  CREATE TABLE assistant_questions (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    source_id TEXT NOT NULL,
    local_date TEXT,
    zone TEXT NOT NULL,
    target_id INTEGER REFERENCES assistant_reminders(id),
    target_version INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','cancelled')),
    created_at INTEGER NOT NULL,
    CHECK ((target_id IS NULL) = (target_version IS NULL))
  ) STRICT;
  CREATE INDEX assistant_open_questions ON assistant_questions(status, id);
`;

const reminderFields = `'R'||r.id AS id, r.text, r.created_at AS createdAt,
  r.due_at AS dueAt, r.zone, r.version, o.state AS status`;
const currentReminders = `FROM assistant_reminders r JOIN assistant_outbox o
  ON o.reminder_id=r.id AND o.version=r.version`;
const questionFields = `'Q'||id AS id, text, local_date AS date, zone,
  'R'||target_id AS targetId, target_version AS targetVersion, status, created_at AS createdAt`;
const moveableStates = "'scheduled','retry','claimed'";

function problem(
  code: Extract<AssistantResult, { kind: "problem" }>["code"],
): AssistantResult {
  return { kind: "problem", code };
}

function itemText(raw: string): string | null {
  const value = raw.trim();
  return value.length &&
    value.length <= MAX_TEXT_LENGTH &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    ? value
    : null;
}

function numberId(raw: string, prefix: "T" | "R" | "Q"): number | null {
  const value = raw.toUpperCase();
  const number = value.startsWith(prefix) ? value.slice(1) : value;
  return /^[1-9]\d{0,14}$/.test(number) ? Number(number) : null;
}

function validTimestamp(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
  );
}

function folded(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function ensurePrivateFile(path: string): void {
  if (path === ":memory:") return;
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "Assistant state needs a private regular file owned by the service user",
    );
  }
}

export class AssistantStore {
  private readonly db: DatabaseSync;
  private readonly zone: string;

  constructor(path: string, scope: AssistantScope) {
    if (!scope.ownerId || !scope.threadId)
      throw new Error("Assistant scope is required");
    new Intl.DateTimeFormat("en", { timeZone: scope.zone });
    this.zone = scope.zone;
    ensurePrivateFile(path);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      this.transaction(() => {
        const version = this.db
          .prepare("PRAGMA user_version")
          .get()?.user_version;
        const application = this.db
          .prepare("PRAGMA application_id")
          .get()?.application_id;
        if (version === 0 && application === 0) {
          const tables = this.db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE substr(name,1,7)<>'sqlite_' LIMIT 1",
            )
            .get();
          if (tables)
            throw new Error(
              "Assistant database already contains unrelated state",
            );
          this.db.exec(schema);
          this.db.exec(
            `PRAGMA user_version=${ASSISTANT_SCHEMA_VERSION}; PRAGMA application_id=${APPLICATION_ID}`,
          );
          this.db
            .prepare(
              "INSERT INTO assistant_scope (singleton,owner_id,thread_id) VALUES (1,?,?)",
            )
            .run(scope.ownerId, scope.threadId);
        } else if (
          version !== ASSISTANT_SCHEMA_VERSION ||
          application !== APPLICATION_ID
        ) {
          throw new Error(
            "Unsupported assistant database schema or application",
          );
        }
        const binding = this.db
          .prepare(
            "SELECT owner_id, thread_id FROM assistant_scope WHERE singleton=1",
          )
          .get();
        if (
          binding?.owner_id !== scope.ownerId ||
          binding?.thread_id !== scope.threadId
        ) {
          throw new Error(
            "Assistant database is bound to another owner or thread",
          );
        }
      });
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  execute(
    messageId: string,
    intent: AssistantIntent,
    now: number,
  ): AssistantResult | null {
    if (!messageId || !validTimestamp(now))
      throw new Error("Invalid assistant message envelope");
    return this.transaction(() => {
      if (
        this.db
          .prepare("SELECT 1 FROM assistant_operations WHERE message_id=?")
          .get(messageId)
      )
        return null;
      const result = this.apply(messageId, intent, now);
      this.db
        .prepare(
          "INSERT INTO assistant_operations (message_id,accepted_at,result_kind) VALUES (?,?,?)",
        )
        .run(messageId, now, result.kind);
      return result;
    });
  }

  private apply(
    messageId: string,
    intent: AssistantIntent,
    now: number,
  ): AssistantResult {
    switch (intent.kind) {
      case "help":
      case "invalid":
        return problem("invalid");
      case "note-add": {
        const text = itemText(intent.text);
        if (!text) return problem("invalid");
        const row = this.db
          .prepare(
            "INSERT INTO assistant_notes (text,searchable_text,source_id,created_at) VALUES (?,?,?,?)",
          )
          .run(text, folded(text), messageId, now);
        return { kind: "note_saved", id: `N${row.lastInsertRowid}` };
      }
      case "notes": {
        const query = folded(intent.query?.trim() ?? "");
        const items = this.db
          .prepare(
            `SELECT 'N'||id AS id, text, created_at AS createdAt
          FROM assistant_notes WHERE instr(searchable_text,?)>0 ORDER BY id DESC LIMIT ?`,
          )
          .all(query, LIST_LIMIT) as unknown as NoteRecord[];
        return { kind: "notes", items };
      }
      case "task-add": {
        const text = itemText(intent.text);
        if (!text) return problem("invalid");
        const row = this.db
          .prepare(
            "INSERT INTO assistant_tasks (text,source_id,created_at) VALUES (?,?,?)",
          )
          .run(text, messageId, now);
        return { kind: "task_added", id: `T${row.lastInsertRowid}` };
      }
      case "tasks": {
        const items = this.db
          .prepare(
            `SELECT 'T'||id AS id, text, created_at AS createdAt,
          'open' AS status, NULL AS dueAt FROM assistant_tasks
          WHERE finished_at IS NULL ORDER BY id DESC LIMIT ?`,
          )
          .all(LIST_LIMIT) as unknown as TaskRecord[];
        return { kind: "tasks", items };
      }
      case "task-done":
        return this.finishTask(intent.id, now);
      case "reminder-set": {
        const text = itemText(intent.text);
        if (!text) return problem("invalid");
        return this.createReminder(
          text,
          messageId,
          intent.dueAt,
          this.zone,
          now,
        );
      }
      case "reminder-move": {
        const selected = this.selectReminder(intent.id);
        return typeof selected === "number"
          ? this.moveReminder(selected, intent.dueAt, this.zone, now)
          : selected;
      }
      case "reminder-cancel":
        return this.cancelReminder(intent.id, now);
      case "reminders": {
        const items = this.db
          .prepare(
            `SELECT ${reminderFields} ${currentReminders} ORDER BY
          o.state NOT IN (${moveableStates},'sending'), r.id DESC LIMIT ?`,
          )
          .all(LIST_LIMIT) as unknown as ReminderRecord[];
        return { kind: "reminders", items };
      }
      case "reminder-question":
        return this.askQuestion(messageId, intent, now);
      case "reminder-answer":
        return this.answerQuestion(messageId, intent, now);
      case "questions":
        return { kind: "questions", items: this.openQuestions(LIST_LIMIT) };
      case "question-cancel": {
        const id = numberId(intent.id, "Q");
        if (!id || !this.closeQuestion(id, "cancelled"))
          return problem("no_question");
        return { kind: "question_cancelled", id: `Q${id}` };
      }
    }
  }

  private finishTask(rawId: string | undefined, now: number): AssistantResult {
    let id: number | null;
    if (rawId !== undefined) {
      id = numberId(rawId, "T");
    } else {
      const open = this.db
        .prepare(
          "SELECT id FROM assistant_tasks WHERE finished_at IS NULL ORDER BY id DESC LIMIT 2",
        )
        .all() as unknown as { id: number }[];
      if (open.length > 1) return problem("multiple_tasks");
      id = open[0]?.id ?? null;
    }
    if (!id) return problem("not_found");
    const change = this.db
      .prepare(
        "UPDATE assistant_tasks SET finished_at=? WHERE id=? AND finished_at IS NULL",
      )
      .run(now, id);
    return change.changes
      ? { kind: "task_done", id: `T${id}` }
      : problem("not_found");
  }

  private reminder(id: number): ReminderRecord | undefined {
    return this.db
      .prepare(`SELECT ${reminderFields} ${currentReminders} WHERE r.id=?`)
      .get(id) as unknown as ReminderRecord | undefined;
  }

  private savedReminder(id: number): AssistantResult {
    const item = this.reminder(id);
    if (!item) throw new Error("Assistant reminder was not saved");
    return { kind: "reminder_saved", item };
  }

  private selectReminder(rawId: string | undefined): number | AssistantResult {
    if (rawId !== undefined)
      return numberId(rawId, "R") ?? problem("not_found");
    const pending = this.db
      .prepare(
        `SELECT r.id ${currentReminders} WHERE o.state IN (${moveableStates}) LIMIT 2`,
      )
      .all() as unknown as { id: number }[];
    if (pending.length > 1) return problem("multiple_reminders");
    return pending[0]?.id ?? problem("not_found");
  }

  private enqueueDelivery(id: number, version: number, dueAt: number): void {
    this.db
      .prepare(
        "INSERT INTO assistant_outbox (reminder_id,version,state,next_attempt_at) VALUES (?,?,'scheduled',?)",
      )
      .run(id, version, dueAt);
  }

  private createReminder(
    text: string,
    messageId: string,
    dueAt: number,
    zone: string,
    now: number,
  ): AssistantResult {
    if (!validTimestamp(dueAt) || dueAt <= now) return problem("invalid_time");
    if (
      this.db
        .prepare(
          `SELECT 1 ${currentReminders}
      WHERE o.state IN (${moveableStates},'sending') LIMIT 1 OFFSET ?`,
        )
        .get(MAX_PENDING_ITEMS - 1)
    )
      return problem("capacity");
    const row = this.db
      .prepare(
        "INSERT INTO assistant_reminders (text,source_id,created_at,due_at,zone) VALUES (?,?,?,?,?)",
      )
      .run(text, messageId, now, dueAt, zone);
    const id = Number(row.lastInsertRowid);
    this.enqueueDelivery(id, 1, dueAt);
    return this.savedReminder(id);
  }

  private cancelOccurrence(id: number, version: number, now: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `UPDATE assistant_outbox
      SET state='cancelled', token=NULL, lease_until=NULL, finished_at=?
      WHERE reminder_id=? AND version=? AND state IN (${moveableStates})`,
        )
        .run(now, id, version).changes,
    );
  }

  private cancelTargetQuestions(
    id: number,
    exceptId: number | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE assistant_questions SET status='cancelled'
      WHERE target_id=? AND id IS NOT ? AND status='open'`,
      )
      .run(id, exceptId);
  }

  private moveReminder(
    id: number,
    dueAt: number,
    zone: string,
    now: number,
    fromQuestion?: number,
  ): AssistantResult {
    if (!validTimestamp(dueAt) || dueAt <= now) return problem("invalid_time");
    const item = this.reminder(id);
    if (!item) return problem("not_found");
    if (!this.cancelOccurrence(id, item.version, now))
      return problem("conflict");
    const version = item.version + 1;
    this.db
      .prepare(
        "UPDATE assistant_reminders SET version=?, due_at=?, zone=? WHERE id=?",
      )
      .run(version, dueAt, zone, id);
    this.enqueueDelivery(id, version, dueAt);
    this.cancelTargetQuestions(id, fromQuestion);
    return this.savedReminder(id);
  }

  private cancelReminder(rawId: string, now: number): AssistantResult {
    const id = numberId(rawId, "R");
    if (id === null) return problem("not_found");
    const item = this.reminder(id);
    if (!item) return problem("not_found");
    if (!this.cancelOccurrence(id, item.version, now))
      return problem("conflict");
    this.cancelTargetQuestions(id);
    return { kind: "reminder_cancelled", id: item.id };
  }

  private openQuestions(limit: number): PendingQuestion[] {
    return this.db
      .prepare(
        `SELECT ${questionFields} FROM assistant_questions
      WHERE status='open' ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as unknown as PendingQuestion[];
  }

  private question(id: number): PendingQuestion | undefined {
    return this.db
      .prepare(`SELECT ${questionFields} FROM assistant_questions WHERE id=?`)
      .get(id) as unknown as PendingQuestion | undefined;
  }

  private closeQuestion(id: number, status: "resolved" | "cancelled"): boolean {
    return Boolean(
      this.db
        .prepare(
          "UPDATE assistant_questions SET status=? WHERE id=? AND status='open'",
        )
        .run(status, id).changes,
    );
  }

  private askQuestion(
    messageId: string,
    intent: Extract<AssistantIntent, { kind: "reminder-question" }>,
    now: number,
  ): AssistantResult {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM assistant_questions WHERE status='open' LIMIT 1 OFFSET ?",
        )
        .get(MAX_PENDING_ITEMS - 1)
    )
      return problem("capacity");
    let text: string | null;
    let targetId: number | null = null;
    let targetVersion: number | null = null;
    if (intent.text !== undefined) {
      text = itemText(intent.text);
      if (!text || intent.id !== undefined) return problem("invalid");
    } else {
      const selected = this.selectReminder(intent.id);
      if (typeof selected !== "number") return selected;
      const item = this.reminder(selected);
      if (!item) return problem("not_found");
      if (!["scheduled", "retry", "claimed"].includes(item.status))
        return problem("conflict");
      text = item.text;
      targetId = selected;
      targetVersion = item.version;
    }
    const question = this.db
      .prepare(
        `INSERT INTO assistant_questions
      (text,source_id,local_date,zone,target_id,target_version,created_at)
      VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        text,
        messageId,
        intent.date ?? null,
        this.zone,
        targetId,
        targetVersion,
        now,
      );
    const item = this.question(Number(question.lastInsertRowid));
    if (!item) throw new Error("Assistant question was not saved");
    return { kind: "question_created", item };
  }

  private answerQuestion(
    messageId: string,
    intent: Extract<AssistantIntent, { kind: "reminder-answer" }>,
    now: number,
  ): AssistantResult {
    let item: PendingQuestion | undefined;
    if (intent.questionId !== undefined) {
      const id = numberId(intent.questionId, "Q");
      if (id !== null) item = this.question(id);
    } else {
      const open = this.openQuestions(2);
      if (open.length > 1) return problem("multiple_questions");
      item = open[0];
    }
    if (!item || item.status !== "open") return problem("no_question");
    const date = intent.date ?? item.date;
    if (!date) return problem("invalid_time");
    const dueAt = resolveAssistantTime(date, intent.time, item.zone);
    if (dueAt === null || !validTimestamp(dueAt) || dueAt <= now)
      return problem("invalid_time");
    const questionId = numberId(item.id, "Q")!;
    let result: AssistantResult;
    if (item.targetId === null) {
      result = this.createReminder(item.text, messageId, dueAt, item.zone, now);
    } else {
      const target = numberId(item.targetId, "R")!;
      if (this.reminder(target)?.version !== item.targetVersion) {
        this.closeQuestion(questionId, "cancelled");
        return problem("conflict");
      }
      result = this.moveReminder(target, dueAt, item.zone, now, questionId);
      if (result.kind === "problem" && result.code === "conflict")
        this.closeQuestion(questionId, "cancelled");
    }
    if (result.kind === "reminder_saved")
      this.closeQuestion(questionId, "resolved");
    return result;
  }

  private recoverExpiredLeases(now: number): void {
    this.db
      .prepare(
        `UPDATE assistant_outbox SET state='scheduled', token=NULL, lease_until=NULL
      WHERE state='claimed' AND lease_until<=?`,
      )
      .run(now);
    this.db
      .prepare(
        `UPDATE assistant_outbox SET state='ambiguous', token=NULL, lease_until=NULL, finished_at=?
      WHERE state='sending' AND lease_until<=?`,
      )
      .run(now, now);
  }

  recoverDeliveries(now: number): void {
    if (!validTimestamp(now))
      throw new Error("Invalid assistant delivery clock");
    this.transaction(() => this.recoverExpiredLeases(now));
  }

  claimDue(now: number, maxLatenessMs: number): DeliveryClaim | null {
    if (
      !validTimestamp(now) ||
      !Number.isSafeInteger(maxLatenessMs) ||
      maxLatenessMs < 0
    ) {
      throw new Error("Invalid assistant delivery clock or lateness window");
    }
    return this.transaction(() => {
      this.recoverExpiredLeases(now);
      this.db
        .prepare(
          `UPDATE assistant_outbox SET state='expired', finished_at=?
        WHERE state IN ('scheduled','retry') AND EXISTS (
          SELECT 1 FROM assistant_reminders r
          WHERE r.id=assistant_outbox.reminder_id AND r.version=assistant_outbox.version AND r.due_at<?
        )`,
        )
        .run(now, now - maxLatenessMs);
      const row = this.db
        .prepare(
          `SELECT 'R'||r.id AS id, r.version, r.text, r.due_at AS dueAt,
        r.zone, o.attempts+1 AS attempt ${currentReminders}
        WHERE o.state IN ('scheduled','retry') AND o.next_attempt_at<=?
        ORDER BY r.due_at, r.id LIMIT 1`,
        )
        .get(now) as unknown as Omit<DeliveryClaim, "token"> | undefined;
      if (!row) return null;
      const token = randomUUID();
      this.db
        .prepare(
          `UPDATE assistant_outbox SET state='claimed', token=?, lease_until=?
        WHERE reminder_id=? AND version=?`,
        )
        .run(token, now + CLAIM_LEASE_MS, numberId(row.id, "R"), row.version);
      return { ...row, token };
    });
  }

  beginDelivery(claim: DeliveryClaim, now: number): boolean {
    if (!validTimestamp(now))
      throw new Error("Invalid assistant delivery clock");
    const id = numberId(claim.id, "R");
    return Boolean(
      this.db
        .prepare(
          `UPDATE assistant_outbox SET state='sending',
      attempts=attempts+1, lease_until=?
      WHERE reminder_id=? AND version=? AND token=? AND state='claimed' AND lease_until>?
      AND EXISTS (SELECT 1 FROM assistant_reminders r WHERE r.id=? AND r.version=?)`,
        )
        .run(
          now + DISPATCH_LEASE_MS,
          id,
          claim.version,
          claim.token,
          now,
          id,
          claim.version,
        ).changes,
    );
  }

  finishDelivery(
    claim: DeliveryClaim,
    outcome: DeliveryOutcome,
    now: number,
  ): void {
    const retryAt = outcome.kind === "retry" ? outcome.retryAt : now;
    if (!validTimestamp(now) || !validTimestamp(retryAt) || retryAt < now) {
      throw new Error("Invalid assistant delivery completion time");
    }
    this.db
      .prepare(
        `UPDATE assistant_outbox SET state=?, next_attempt_at=?, message_id=?,
      token=NULL, lease_until=NULL, finished_at=?
      WHERE reminder_id=? AND version=? AND token=? AND state='sending'`,
      )
      .run(
        outcome.kind,
        retryAt,
        outcome.kind === "sent" ? outcome.messageId : null,
        outcome.kind === "retry" ? null : now,
        numberId(claim.id, "R"),
        claim.version,
        claim.token,
      );
  }
}
