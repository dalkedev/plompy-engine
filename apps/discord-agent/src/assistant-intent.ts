export type AssistantLocale = "en" | "pl";

export type AssistantIntent =
  | { kind: "help" }
  | { kind: "invalid" }
  | { kind: "tasks" }
  | { kind: "reminders" }
  | { kind: "questions" }
  | { kind: "note-add"; text: string }
  | { kind: "task-add"; text: string }
  | { kind: "notes"; query?: string }
  | { kind: "task-done"; id?: string }
  | { kind: "reminder-set"; text: string; dueAt: number }
  | { kind: "reminder-move"; id?: string; dueAt: number }
  | { kind: "reminder-cancel"; id: string }
  | { kind: "question-cancel"; id: string }
  | { kind: "reminder-question"; text: string; date?: string; id?: never }
  | { kind: "reminder-question"; id?: string; date?: string; text?: never }
  | {
      kind: "reminder-answer";
      questionId?: string;
      time: string;
      date?: string;
    };

interface ParseOptions {
  now: number;
  zone: string;
  locale: AssistantLocale;
}

const dayPattern = String.raw`(?:\d{4}-\d{2}-\d{2}|today|tomorrow|dzi[sś](?:iaj)?|jutro|pojutrze)`;
const timePattern = String.raw`\d{2}:\d{2}(?:\s+UTC[+-]\d{2}:\d{2})?`;
const relativePattern = String.raw`(?:za|in)\s+(\d{1,4})\s*(min(?:\.|ut(?:a|y|ę)?|utes?)?|m|hours?|h|godz(?:\.|in(?:ę|y|a)?)?)`;
const absolutePattern = String.raw`(?:(${dayPattern})(?:\s+(?:(?:o|at)\s+)?(${timePattern}))?|(?:(?:o|at)\s+)?(${timePattern}))`;
const absoluteTime = new RegExp(`^${absolutePattern}$`, "iu");
const relativeTime = new RegExp(`^${relativePattern}$`, "iu");
const leadingSchedule = new RegExp(
  String.raw`^(${relativePattern}|${absolutePattern})(?=$|[\s,])`,
  "iu",
);
const trailingSchedule = new RegExp(
  String.raw`\s+(${relativePattern}|${absolutePattern})$`,
  "iu",
);
const invalid: AssistantIntent = { kind: "invalid" };
const help: AssistantIntent = { kind: "help" };

function localWallTime(ms: number, format: Intl.DateTimeFormat): string {
  const parts = new Map(
    format.formatToParts(ms).map(({ type, value }) => [type, value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}T${parts.get("hour")}:${parts.get("minute")}:00.000Z`;
}

function wallClock(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function isCalendarDate(date: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date)
  );
}

const clockTime =
  /^([01]\d|2[0-3]):([0-5]\d)(?:\s+UTC([+-])([01]\d|2[0-3]):([0-5]\d))?$/i;

export function localAssistantDate(now: number, zone: string): string {
  return localWallTime(now, wallClock(zone)).slice(0, 10);
}

export function formatAssistantTime(
  ms: number,
  zone: string,
  locale: AssistantLocale,
): string {
  const time = new Intl.DateTimeFormat(locale === "pl" ? "pl-PL" : "en-GB", {
    timeZone: zone,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
    hourCycle: "h23",
  }).format(ms);
  return `${time} (${zone})`;
}

/** A local gap or fold requires a new answer unless a valid UTC offset selects the occurrence. */
export function resolveAssistantTime(
  date: string,
  time: string,
  zone: string,
): number | null {
  if (!isCalendarDate(date)) return null;
  const match = time.match(clockTime);
  if (!match) return null;
  const local = `${date}T${match[1]}:${match[2]}:00.000Z`;
  const wall = Date.parse(local);
  const format = wallClock(zone);
  if (match[3]) {
    const offset = (Number(match[4]) * 60 + Number(match[5])) * 60_000;
    const instant = wall + (match[3] === "+" ? -offset : offset);
    return localWallTime(instant, format) === local ? instant : null;
  }

  // Sample both sides of nearby timezone changes. Validate candidates against the
  // exact wall clock so forward jumps yield no match and backward jumps yield two.
  const instants = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = wall + hours * 3_600_000;
    const offset = Date.parse(localWallTime(sample, format)) - sample;
    const instant = wall - offset;
    if (localWallTime(instant, format) === local) instants.add(instant);
  }
  return instants.size === 1 ? (instants.values().next().value ?? null) : null;
}

function parseAbsolute(
  source: string,
  { now, zone }: ParseOptions,
): { date?: string; time?: string } | null {
  const match = source.match(absoluteTime);
  if (!match) return null;
  const day = match[1]?.toLowerCase();
  const time = match[2] ?? match[3];
  if (!day) return time ? { time } : null;
  if (day.includes("-")) {
    if (!isCalendarDate(day)) return null;
    return time ? { date: day, time } : { date: day };
  }
  const days =
    day === "pojutrze" ? 2 : ["tomorrow", "jutro"].includes(day) ? 1 : 0;
  const today = Date.parse(`${localAssistantDate(now, zone)}T00:00:00Z`);
  const date = new Date(today + days * 86_400_000).toISOString().slice(0, 10);
  return time ? { date, time } : { date };
}

function parseWhen(
  source: string,
  options: ParseOptions,
): { dueAt: number } | { date?: string } | null {
  if (!source) return {};
  const relative = source.match(relativeTime);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2]?.toLowerCase() ?? "";
    const minutes = count * (/^(?:h|godz)/u.test(unit) ? 60 : 1);
    if (minutes < 1 || minutes > 7 * 24 * 60) return null;
    return { dueAt: options.now + minutes * 60_000 };
  }
  const value = parseAbsolute(source, options);
  if (!value) return null;
  const { date, time } = value;
  if (!date) return {};
  if (date < localAssistantDate(options.now, options.zone)) return null;
  if (time) {
    const dueAt = resolveAssistantTime(date, time, options.zone);
    if (dueAt !== null && dueAt > options.now) return { dueAt };
  }
  return { date };
}

function addReminder(
  text: string,
  when: string,
  options: ParseOptions,
): AssistantIntent {
  if (!text) return invalid;
  const schedule = parseWhen(when, options);
  if (!schedule) return invalid;
  return "dueAt" in schedule
    ? { kind: "reminder-set", text, dueAt: schedule.dueAt }
    : { kind: "reminder-question", text, ...schedule };
}

function moveReminder(
  id: string | undefined,
  when: string,
  options: ParseOptions,
): AssistantIntent {
  const schedule = parseWhen(when, options);
  if (!schedule) return invalid;
  if ("dueAt" in schedule)
    return {
      kind: "reminder-move",
      dueAt: schedule.dueAt,
      ...(id ? { id } : {}),
    };
  return { kind: "reminder-question", ...(id ? { id } : {}), ...schedule };
}

function idFor(value: string, prefix: "T" | "R" | "Q"): string | undefined {
  const token = value.trim().toUpperCase().replace(/^#/, "");
  const digits = token.startsWith(prefix) ? token.slice(1) : token;
  if (!/^[1-9]\d{0,14}$/.test(digits)) return undefined;
  return prefix + digits;
}

function readId(text: string, prefix: "R" | "Q"): [string, string] | undefined {
  const match = text.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  const id = match?.[1] ? idFor(match[1], prefix) : undefined;
  return id ? [id, match?.[2] ?? ""] : undefined;
}

function done(source: string): AssistantIntent {
  if (!source) return { kind: "task-done" };
  const id = idFor(source, "T");
  return id ? { kind: "task-done", id } : invalid;
}

function cancel(
  kind: "reminder-cancel" | "question-cancel",
  source: string,
): AssistantIntent {
  const id = idFor(source, kind === "reminder-cancel" ? "R" : "Q");
  return id ? { kind, id } : invalid;
}

function answer(
  source: string,
  options: ParseOptions,
  questionId?: string,
): AssistantIntent | null {
  const value = parseAbsolute(source, options);
  if (!value?.time || !clockTime.test(value.time)) return null;
  return {
    kind: "reminder-answer",
    time: value.time,
    ...(value.date ? { date: value.date } : {}),
    ...(questionId ? { questionId } : {}),
  };
}

function contentIntent(
  kind: "note-add" | "task-add",
  text: string,
): AssistantIntent {
  return text ? { kind, text } : invalid;
}

function listNotes(query: string): AssistantIntent {
  return query ? { kind: "notes", query } : { kind: "notes" };
}

function parseCommand(command: string, options: ParseOptions): AssistantIntent {
  const match = command.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  const operation = match?.[1]?.toLowerCase() ?? "help";
  const args = match?.[2]?.trim() ?? "";
  switch (operation) {
    case "help":
      return args ? invalid : help;
    case "note":
      return contentIntent("note-add", args);
    case "notes":
      return listNotes(args);
    case "task":
      return contentIntent("task-add", args);
    case "tasks":
      return args ? invalid : { kind: "tasks" };
    case "done":
      return done(args);
    case "remind": {
      const separator = args.indexOf("|");
      return separator < 0
        ? invalid
        : addReminder(
            args.slice(separator + 1).trim(),
            args.slice(0, separator).trim(),
            options,
          );
    }
    case "move": {
      const parsed = readId(args, "R");
      return parsed ? moveReminder(...parsed, options) : invalid;
    }
    case "cancel":
      return cancel("reminder-cancel", args);
    case "reminders":
      return args ? invalid : { kind: "reminders" };
    case "answer": {
      const parsed = readId(args, "Q");
      return parsed
        ? (answer(parsed[1], options, parsed[0]) ?? invalid)
        : invalid;
    }
    case "questions":
      return args ? invalid : { kind: "questions" };
    case "question-cancel":
      return cancel("question-cancel", args);
    default:
      return invalid;
  }
}

function stripTopicPrefix(text: string): string {
  return text.replace(/^(?:,|:)\s*|^(?:to|about|o|żeby|aby)\s+/iu, "").trim();
}

function naturalReminder(
  source: string,
  options: ParseOptions,
): AssistantIntent {
  const prefix = source.match(leadingSchedule)?.[0];
  if (prefix) {
    const topic = source
      .slice(prefix.length)
      .trim()
      .replace(/^[,:]\s*/u, "");
    return addReminder(stripTopicPrefix(topic), prefix, options);
  }
  const suffix = source.match(trailingSchedule);
  if (suffix?.[1] && suffix.index !== undefined) {
    const topic = source.slice(0, suffix.index).trim();
    if (/(?:^|\s)(?:lub|albo|or)$/iu.test(topic)) return invalid;
    return addReminder(stripTopicPrefix(topic), suffix[1], options);
  }
  return addReminder(stripTopicPrefix(source), "", options);
}

function naturalMove(source: string, options: ParseOptions): AssistantIntent {
  const args = source.replace(/^(?:to|at|na)\s+/iu, "");
  const match = readId(args, "R");
  const when = match ? match[1].replace(/^(?:to|at|na)\s+/iu, "") : args;
  const vague =
    /^(?:rano|wieczór|wieczorem|po południu|this evening|morning|afternoon)[.!]?$/iu;
  return moveReminder(match?.[0], vague.test(when) ? "" : when, options);
}

export function parseAssistantIntent(
  source: string,
  options: ParseOptions,
): AssistantIntent {
  const message = source.trim();
  if (!message || message.length > 8_000) return invalid;
  const command = message.match(/^!assistant(?:\s+([\s\S]*))?$/iu);
  if (command) return parseCommand(command[1] ?? "", options);
  if (message.startsWith("!")) return invalid;

  if (/^(?:pomoc|help)$/iu.test(message)) return help;
  if (
    /^(?:pokaż (?:moje )?(?:otwarte )?(?:zadania|sprawy)|(?:list|show) (?:my )?(?:open )?tasks|zadania|tasks)[.!?]?$/iu.test(
      message,
    )
  )
    return { kind: "tasks" };
  if (
    /^(?:pokaż (?:moje )?przypomnienia|(?:list|show) (?:my )?reminders|przypomnienia|reminders)[.!?]?$/iu.test(
      message,
    )
  )
    return { kind: "reminders" };

  const note = message.match(
    /^(?:zapisz(?:\s+notatkę)?|zanotuj|zapamiętaj|save\s+(?:a\s+)?note|take\s+(?:a\s+)?note|remember)(?:\s*[:,]\s*|\s+)([\s\S]+)$/iu,
  );
  if (note?.[1]) return contentIntent("note-add", note[1]);
  const notes = message.match(
    /^(?:pokaż(?:\s+moje)?\s+notatki|(?:znajdź|wyszukaj)\s+notat(?:kę|ki)|(?:find|search|show|list)\s+(?:my\s+)?notes?)(?:\s+(?:(?:o|about|for)\s+)?([\s\S]+))?[.!?]?$/iu,
  );
  if (notes) return listNotes(notes[1] ?? "");
  const task = message.match(
    /^(?:dodaj\s+zadanie|(?:add|create)\s+(?:a\s+)?task)(?:\s*:\s*|\s+)([\s\S]+)$/iu,
  );
  if (task?.[1]) return contentIntent("task-add", task[1]);
  const completed = message.match(
    /^(?:zrobione|gotowe|ukończ(?:\s+zadanie)?|done|complete(?:\s+task)?|mark(?:\s+task)?)(?:\s+(#?[Tt]?[1-9]\d{0,14}))?(?:\s+done)?[.!]?$/iu,
  );
  if (completed) return done(completed[1] ?? "");

  const reminder = message.match(
    /^(?:przypomnij\s+mi|remind\s+me)\s+([\s\S]+)$/iu,
  );
  if (reminder?.[1]) return naturalReminder(reminder[1], options);
  const cancelled = message.match(
    /^(?:anuluj\s+przypomnienie|cancel\s+reminder)\s+(\S+?)[.!]?$/iu,
  );
  if (cancelled?.[1]) return cancel("reminder-cancel", cancelled[1]);
  const moved = message.match(
    /^(?:przełóż(?:\s+(?:przypomnienie|to))?|(?:move|reschedule)(?:\s+(?:reminder|it))?)\s+([\s\S]+)$/iu,
  );
  if (moved?.[1]) return naturalMove(moved[1], options);
  return answer(message, options) ?? invalid;
}
