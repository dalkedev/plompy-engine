import {
  authorized,
  redact,
  SNOWFLAKE,
  type Config,
  type Incoming,
} from "./config.js";
import {
  formatAssistantTime,
  parseAssistantIntent,
} from "./assistant-intent.js";
import type { AssistantResult, AssistantStore } from "./assistant-store.js";

export type AssistantLocale = "en" | "pl";

export interface AssistantSettings {
  threadId: string;
  locale: AssistantLocale;
  zone: string;
  maxLatenessMs: number;
}

export function loadAssistantSettings(
  env = process.env,
): AssistantSettings | undefined {
  const threadId = env.PLOMPY_ASSISTANT_THREAD_ID;
  if (!threadId) return undefined;
  if (!SNOWFLAKE.test(threadId)) throw new Error("Invalid assistant thread ID");
  const locale = env.PLOMPY_ASSISTANT_LOCALE ?? "en";
  if (locale !== "en" && locale !== "pl")
    throw new Error("Invalid assistant locale");
  const zone = env.PLOMPY_ASSISTANT_TIME_ZONE ?? "UTC";
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone))
    throw new Error("Expected an IANA assistant time zone");
  new Intl.DateTimeFormat("en", { timeZone: zone });
  const minutes = env.PLOMPY_ASSISTANT_MAX_LATE_MINUTES ?? "";
  if (!/^[1-9]\d{0,3}$/.test(minutes) || Number(minutes) > 1440)
    throw new Error(
      "Choose an assistant late-delivery window from 1 to 1440 minutes",
    );
  return { threadId, locale, zone, maxLatenessMs: Number(minutes) * 60_000 };
}

type AssistantTransport = {
  send(threadId: string, text: string): Promise<void>;
};

const help = [
  "`!assistant note TEXT` · `!assistant notes [QUERY]`",
  "`!assistant task TEXT` · `!assistant tasks` · `!assistant done [T1]`",
  "`!assistant remind tomorrow 14:30 | TEXT` · `!assistant reminders`",
  "`!assistant move R1 tomorrow 15:00` · `!assistant cancel R1`",
  "`!assistant questions` · `!assistant answer Q1 14:30` · `!assistant question-cancel Q1`",
].join("\n");

const deliveryStates = {
  scheduled: ["scheduled", "zaplanowane"],
  claimed: ["preparing", "przygotowywane"],
  sending: ["sending", "w trakcie wysyłki"],
  retry: ["waiting to retry", "oczekuje na ponowienie"],
  sent: ["accepted by Discord", "przyjęte przez Discorda"],
  failed: ["delivery failed", "wysyłka nieudana"],
  ambiguous: ["delivery uncertain", "wynik wysyłki niepewny"],
  expired: ["missed after downtime", "po terminie"],
  cancelled: ["cancelled", "anulowane"],
} as const;

function formatResult(
  result: AssistantResult,
  settings: AssistantSettings,
): string {
  const pl = settings.locale === "pl";
  const format = (time: number, zone: string) =>
    formatAssistantTime(time, zone, settings.locale);
  const rows = (lines: string[]) =>
    lines.length ? lines.join("\n") : pl ? "Brak wpisów." : "No entries.";
  switch (result.kind) {
    case "note_saved":
      return pl ? `Zapisana notatka ${result.id}.` : `Saved note ${result.id}.`;
    case "notes":
      return rows(result.items.map(({ id, text }) => `**${id}** · ${text}`));
    case "task_added":
      return pl ? `Zapisane zadanie ${result.id}.` : `Added task ${result.id}.`;
    case "tasks":
      return rows(result.items.map(({ id, text }) => `**${id}** · ${text}`));
    case "task_done":
      return pl
        ? `Zadanie ${result.id} wykonane.`
        : `Completed task ${result.id}.`;
    case "reminder_saved":
      return pl
        ? `Przypomnienie ${result.item.id} zapisane na ${format(result.item.dueAt, result.item.zone)}.`
        : `Reminder ${result.item.id} scheduled for ${format(result.item.dueAt, result.item.zone)}.`;
    case "reminders":
      return rows(
        result.items.map(
          (item) =>
            `**${item.id}** · ${format(item.dueAt, item.zone)} · ${deliveryStates[item.status][pl ? 1 : 0]}\n${item.text}`,
        ),
      );
    case "reminder_cancelled":
      return pl
        ? `Przypomnienie ${result.id} anulowane.`
        : `Cancelled reminder ${result.id}.`;
    case "question_created": {
      const { date, id } = result.item;
      const answer = date ? "14:30" : "2030-01-25 14:30";
      return pl
        ? `**${id}** · ${date ? `O której godzinie (${date})?` : "Którego dnia i o której godzinie?"}\nPrzykład odpowiedzi: \`!assistant answer ${id} ${answer}\`.`
        : `**${id}** · ${date ? `At what time (${date})?` : "On which day and at what time?"}\nExample reply: \`!assistant answer ${id} ${answer}\`.`;
    }
    case "questions":
      return rows(
        result.items.map(
          ({ id, date, text }) =>
            `**${id}** · ${date ?? (pl ? "brak daty" : "date needed")} · ${text}`,
        ),
      );
    case "question_cancelled":
      return pl
        ? `Pytanie ${result.id} anulowane.`
        : `Cancelled question ${result.id}.`;
    case "problem": {
      if (result.code === "no_question")
        return pl
          ? "Brak otwartego pytania o termin."
          : "There is no open question about a reminder.";
      if (result.code === "multiple_questions")
        return pl
          ? "Podaj ID pytania. Wpisz `!assistant questions`, żeby zobaczyć listę."
          : "Specify the question ID. Use `!assistant questions` to list them.";
      if (result.code === "multiple_tasks")
        return pl
          ? "Które zadanie jest wykonane? Wpisz `!assistant tasks`, a potem np. `!assistant done T1`."
          : "Which task is complete? Use `!assistant tasks`, then e.g. `!assistant done T1`.";
      if (result.code === "multiple_reminders")
        return pl
          ? "Które przypomnienie przełożyć? Wpisz `!assistant reminders`, a potem np. `!assistant move R1 tomorrow 15:00`."
          : "Which reminder should move? Use `!assistant reminders`, then e.g. `!assistant move R1 tomorrow 15:00`.";
      if (result.code === "invalid_time")
        return pl
          ? "Podaj przyszłą datę i jednoznaczną godzinę. Przy zmianie czasu użyj przesunięcia, np. `02:30 UTC+01:00`."
          : "Give a future date and an unambiguous time. For a clock change, include the offset, e.g. `02:30 UTC+01:00`.";
      if (result.code === "conflict")
        return pl
          ? "Wpis już się zmienił albo trwa jego wysyłka. Sprawdź aktualną listę przed kolejną zmianą."
          : "The entry changed or is already being sent. Check the list before trying again.";
      if (result.code === "not_found")
        return pl
          ? "Podaj ID z aktualnej listy."
          : "Specify an ID from the current list.";
      if (result.code === "capacity")
        return pl
          ? "Osiągnięto limit otwartych wpisów."
          : "The open-entry limit has been reached.";
      return (pl ? "Sprawdź polecenie.\n" : "Check the command.\n") + help;
    }
  }
}

export class PersonalAssistant {
  constructor(
    private config: Pick<Config, "guildId" | "ownerId" | "parentId" | "token">,
    private settings: AssistantSettings,
    private store: Pick<AssistantStore, "execute">,
    private transport: AssistantTransport,
    private now = Date.now,
  ) {}

  async handle(message: Incoming): Promise<boolean> {
    if (message.channelId !== this.settings.threadId) return false;
    if (!authorized(message, this.config)) return true;
    const { threadId, locale, zone } = this.settings;
    const now = this.now();
    const createdAt = Number(BigInt(message.id) >> 22n) + 1_420_070_400_000;
    const intent = message.attachments
      ? { kind: "invalid" as const }
      : parseAssistantIntent(redact(message.content, this.config.token), {
          now: createdAt,
          zone,
          locale,
        });
    if (intent.kind === "help" || intent.kind === "invalid") {
      await this.transport.send(threadId, help);
      return true;
    }
    if (
      intent.kind === "reminder-answer" &&
      message.replyToId &&
      !intent.questionId
    ) {
      await this.transport.send(
        threadId,
        locale === "pl"
          ? "W odpowiedzi Discord podaj ID pytania, np. `!assistant answer Q1 14:30`."
          : "Include the question ID in a Discord reply, e.g. `!assistant answer Q1 14:30`.",
      );
      return true;
    }
    const result = this.store.execute(message.id, intent, now);
    if (result)
      await this.transport.send(threadId, formatResult(result, this.settings));
    return true;
  }
}
