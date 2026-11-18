import type { DeliveryClaim, AssistantStore } from "./assistant-store.js";

type DeliveryStore = Pick<
  AssistantStore,
  "claimDue" | "beginDelivery" | "finishDelivery" | "recoverDeliveries"
>;

export type ReminderSendResult =
  | { kind: "sent"; messageId: string }
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "failed" }
  | { kind: "ambiguous" };

type SendReminder = (
  threadId: string,
  content: string,
) => Promise<ReminderSendResult>;

interface Options {
  threadId: string;
  locale: "en" | "pl";
  maxLatenessMs: number;
  now?: () => number;
  onError?: () => void;
}

const POLL_MS = 5_000;
const FIRST_BACKOFF_MS = 15_000;
const MAX_ATTEMPTS = 3;
const MAX_PER_TICK = 4;
const MESSAGE_LIMIT = 1_800;

function messageFor(
  claim: DeliveryClaim,
  locale: Options["locale"],
  now: number,
): string {
  const late = now - claim.dueAt >= 60_000;
  const heading =
    locale === "pl"
      ? late
        ? "Opóźnione przypomnienie"
        : "Przypomnienie"
      : late
        ? "Delayed reminder"
        : "Reminder";
  const due = new Intl.DateTimeFormat(locale === "pl" ? "pl-PL" : "en-GB", {
    timeZone: claim.zone,
    dateStyle: "long",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(claim.dueAt);
  return `**${heading} ${claim.id}** · ${due} (${claim.zone})\n${claim.text}`;
}

export class ReminderScheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private readonly now: () => number;

  constructor(
    private readonly store: DeliveryStore,
    private readonly send: SendReminder,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.store.recoverDeliveries(this.now());
    const poll = (): void => {
      void this.tick().catch(() => this.options.onError?.());
    };
    this.timer = setInterval(poll, POLL_MS);
    poll();
  }

  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped) return Promise.resolve();
    this.inFlight = Promise.resolve()
      .then(() => this.deliverDue())
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private async deliverDue(): Promise<void> {
    for (let index = 0; index < MAX_PER_TICK && !this.stopped; index++) {
      const now = this.now();
      const claim = this.store.claimDue(now, this.options.maxLatenessMs);
      if (!claim) return;
      const content = messageFor(claim, this.options.locale, now);
      // Assignment alone does not authorize a send. Cancellation/rescheduling
      // may have superseded the claim before this durable transition.
      if (!this.store.beginDelivery(claim, this.now())) continue;
      const result = await this.dispatch(content);
      const finishedAt = this.now();
      if (result.kind !== "retry") {
        this.store.finishDelivery(claim, result, finishedAt);
        continue;
      }
      if (claim.attempt >= MAX_ATTEMPTS) {
        this.store.finishDelivery(claim, { kind: "failed" }, finishedAt);
        continue;
      }
      const backoff = FIRST_BACKOFF_MS * 2 ** (claim.attempt - 1);
      const requested = result.retryAfterMs ?? 0;
      const delay = Number.isFinite(requested)
        ? Math.max(backoff, requested)
        : backoff;
      const retryAt = finishedAt + Math.ceil(delay);
      // A definitive rejection still cannot be retried earlier than Discord
      // allows, or later than the configured delivery window.
      const canRetry =
        Number.isFinite(new Date(retryAt).getTime()) &&
        retryAt <= claim.dueAt + this.options.maxLatenessMs;
      this.store.finishDelivery(
        claim,
        canRetry ? { kind: "retry", retryAt } : { kind: "failed" },
        finishedAt,
      );
    }
  }

  private async dispatch(content: string): Promise<ReminderSendResult> {
    if (content.length > MESSAGE_LIMIT) return { kind: "failed" };
    try {
      return await this.send(this.options.threadId, content);
    } catch {
      // A rejected promise alone does not establish that Discord rejected the
      // request. Only explicit, known pre-dispatch/rejection outcomes can retry.
      return { kind: "ambiguous" };
    }
  }
}
