import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAssistantTime,
  localAssistantDate,
  parseAssistantIntent,
  resolveAssistantTime,
} from "../dist/assistant-intent.js";

const zone = "Europe/Warsaw";
const now = Date.parse("2026-11-18T23:15:00Z");
const parse = (text, locale = "pl") =>
  parseAssistantIntent(text, { now, zone, locale });

test("Polish and English requests preserve note text and allow tasks without a due date", () => {
  const content = "Pomysł do rolki o retry; webhooki\ni przykład.";
  assert.deepEqual(parse(`Zapisz ${content}`), {
    kind: "note-add",
    text: content,
  });
  assert.deepEqual(parse("Save a note: Keep the API header as-is", "en"), {
    kind: "note-add",
    text: "Keep the API header as-is",
  });
  assert.deepEqual(parse("Znajdź notatkę o retry"), {
    kind: "notes",
    query: "retry",
  });
  assert.deepEqual(parse("Pokaż notatki"), { kind: "notes" });
  assert.deepEqual(parse("Dodaj zadanie: kupić filtr"), {
    kind: "task-add",
    text: "kupić filtr",
  });
  assert.deepEqual(parse("Pokaż otwarte sprawy"), { kind: "tasks" });
  assert.deepEqual(parse("Zrobione"), { kind: "task-done" });
  assert.deepEqual(parse("!assistant done #2"), {
    kind: "task-done",
    id: "T2",
  });
});

test("tomorrow means the next local day at message receipt, before any later handling", () => {
  assert.equal(localAssistantDate(now, zone), "2026-11-19");
  assert.deepEqual(parse("Przypomnij mi jutro o filtrze"), {
    kind: "reminder-question",
    text: "filtrze",
    date: "2026-11-20",
  });
  const dueAt = Date.parse("2026-11-20T17:30:00Z");
  assert.deepEqual(parse("Przypomnij mi jutro o 18:30, żeby kupić filtr"), {
    kind: "reminder-set",
    text: "kupić filtr",
    dueAt,
  });
  assert.deepEqual(parse("Remind me to buy a filter tomorrow at 18:30", "en"), {
    kind: "reminder-set",
    text: "buy a filter",
    dueAt,
  });
  assert.deepEqual(
    parse("!assistant remind tomorrow 18:30 | Buy a filter", "en"),
    {
      kind: "reminder-set",
      text: "Buy a filter",
      dueAt,
    },
  );
  assert.match(
    formatAssistantTime(dueAt, zone, "pl"),
    /20 listopada 2026.*18:30.*Europe\/Warsaw/,
  );
});

test("relative times, moving, canceling and answering use bounded, typed arguments", () => {
  assert.deepEqual(parse("Przypomnij mi za 5 minut o filtrze"), {
    kind: "reminder-set",
    text: "filtrze",
    dueAt: now + 5 * 60_000,
  });
  assert.deepEqual(parse("Remind me to stretch in 1 hour", "en"), {
    kind: "reminder-set",
    text: "stretch",
    dueAt: now + 60 * 60_000,
  });
  assert.deepEqual(parse("Przełóż to na jutro o 16:00"), {
    kind: "reminder-move",
    dueAt: Date.parse("2026-11-20T15:00:00Z"),
  });
  assert.deepEqual(parse("!assistant move r2 jutro"), {
    kind: "reminder-question",
    id: "R2",
    date: "2026-11-20",
  });
  assert.deepEqual(parse("Anuluj przypomnienie #3."), {
    kind: "reminder-cancel",
    id: "R3",
  });
  assert.deepEqual(parse("!assistant reminders"), { kind: "reminders" });
  assert.deepEqual(parse("O 18:30"), {
    kind: "reminder-answer",
    time: "18:30",
  });
  assert.deepEqual(parse("!assistant answer #4 jutro o 18:30"), {
    kind: "reminder-answer",
    questionId: "Q4",
    date: "2026-11-20",
    time: "18:30",
  });
  assert.deepEqual(parse("!assistant questions"), { kind: "questions" });
  assert.deepEqual(parse("!assistant question-cancel q4"), {
    kind: "question-cancel",
    id: "Q4",
  });
});

test("invalid calendar dates and DST gaps are rejected and folds require the actual offset", () => {
  assert.equal(resolveAssistantTime("2026-02-30", "18:30", zone), null);
  assert.equal(resolveAssistantTime("2026-03-29", "25:00", zone), null);
  assert.equal(resolveAssistantTime("2026-03-29", "02:30", zone), null);
  assert.equal(
    resolveAssistantTime("2026-03-29", "02:30 UTC+02:00", zone),
    null,
  );
  assert.equal(resolveAssistantTime("2026-10-25", "02:30", zone), null);
  assert.equal(
    resolveAssistantTime("2026-10-25", "02:30 UTC+02:00", zone),
    Date.parse("2026-10-25T00:30:00Z"),
  );
  assert.equal(
    resolveAssistantTime("2026-10-25", "02:30 UTC+01:00", zone),
    Date.parse("2026-10-25T01:30:00Z"),
  );
  assert.equal(
    resolveAssistantTime("2026-10-25", "02:30 UTC+03:00", zone),
    null,
  );
  const inOctober = (text) =>
    parseAssistantIntent(text, {
      now: Date.parse("2026-10-24T10:00:00Z"),
      zone,
      locale: "pl",
    });
  assert.deepEqual(inOctober("Przypomnij mi jutro o 02:30 o starcie"), {
    kind: "reminder-question",
    text: "starcie",
    date: "2026-10-25",
  });
  assert.deepEqual(inOctober("!assistant answer Q10 02:30 UTC+01:00"), {
    kind: "reminder-answer",
    questionId: "Q10",
    time: "02:30 UTC+01:00",
  });
});

test("unrecognized and malformed requests cannot guess an operation or a date", () => {
  for (const message of [
    "Tak",
    "!assistant fake anything",
    "!assistant tasks ignore that other thing",
    "!assistant note",
    "!assistant cancel T3",
    "!assistant remind 2026-02-30 18:30 | Filter",
    "!assistant remind 2026-11-17 18:30 | Filter",
    "!assistant remind in 0 minutes | Filter",
    "Przypomnij mi o filtrze jutro albo pojutrze",
    "25:30",
    "!work 30m",
  ])
    assert.equal(parse(message).kind, "invalid", message);
  assert.deepEqual(parse("!assistant help"), { kind: "help" });
});
