import assert from "node:assert/strict";
import test from "node:test";
import { loadAssistantSettings, PersonalAssistant } from "../dist/assistant.js";
import { ReminderScheduler } from "../dist/assistant-delivery.js";
import { AssistantStore } from "../dist/assistant-store.js";

const config = {
  guildId: "111111111111111111",
  ownerId: "222222222222222222",
  parentId: "333333333333333333",
  token: "synthetic-bot-token",
};
const threadId = "444444444444444444";
const settings = {
  threadId,
  locale: "pl",
  zone: "Europe/Warsaw",
  maxLatenessMs: 360_000,
};
const discordEpoch = 1_420_070_400_000n;
const now = Date.parse("2027-01-02T10:00:00Z");
const createMessage = (content, sequence, overrides = {}) => ({
  id: String(((BigInt(now) - discordEpoch) << 22n) + BigInt(sequence)),
  guildId: config.guildId,
  authorId: config.ownerId,
  parentId: config.parentId,
  channelId: threadId,
  thread: true,
  bot: false,
  webhook: false,
  content,
  attachments: 0,
  ...overrides,
});

test("assistant is opt-in and requires a valid explicit lateness policy", () => {
  assert.equal(loadAssistantSettings({}), undefined);
  const env = {
    PLOMPY_ASSISTANT_THREAD_ID: threadId,
    PLOMPY_ASSISTANT_TIME_ZONE: "Europe/Warsaw",
    PLOMPY_ASSISTANT_LOCALE: "pl",
    PLOMPY_ASSISTANT_MAX_LATE_MINUTES: "6",
  };
  assert.deepEqual(loadAssistantSettings(env), settings);
  for (const value of ["", "-10", "1441", "1.5"])
    assert.throws(() =>
      loadAssistantSettings({
        ...env,
        PLOMPY_ASSISTANT_MAX_LATE_MINUTES: value,
      }),
    );
  assert.throws(() =>
    loadAssistantSettings({ ...env, PLOMPY_ASSISTANT_TIME_ZONE: "Fake/Zone" }),
  );
});

test("assistant consumes only its thread, rejects other actors, and persists before reply", async () => {
  const store = new AssistantStore(":memory:", {
    ...settings,
    ownerId: config.ownerId,
  });
  try {
    const replies = [];
    const assistant = new PersonalAssistant(
      config,
      settings,
      store,
      { send: async (id, text) => replies.push({ id, text }) },
      () => now,
    );
    assert.equal(
      await assistant.handle(
        createMessage("Zapisz notatkę o stole", 1, {
          channelId: "555555555555555555",
        }),
      ),
      false,
    );
    for (const overrides of [
      { authorId: "555555555555555555" },
      { parentId: "555555555555555555" },
      { guildId: "555555555555555555" },
      { bot: true },
      { webhook: true },
    ]) {
      await assistant.handle(
        createMessage("!assistant note Should not be stored", 2, overrides),
      );
    }
    assert.equal(replies.length, 0);
    const note = createMessage(
      "Zapisz pomysł do rolki o ponawianiu webhooków",
      3,
    );
    await assistant.handle(note);
    await assistant.handle(note);
    await assistant.handle(createMessage("!assistant notes webhook", 4));
    assert.deepEqual(
      replies.map(({ id }) => id),
      [threadId, threadId],
    );
    assert.match(replies[0].text, /N1/);
    assert.match(replies[1].text, /ponawianiu webhooków/);
    assert.doesNotMatch(replies[1].text, /Should not/);
  } finally {
    store.close();
  }
});

test("a live question does not block due reminders or prevent another task from being saved", async () => {
  const store = new AssistantStore(":memory:", {
    ...settings,
    ownerId: config.ownerId,
  });
  const replies = [];
  const deliveries = [];
  const assistant = new PersonalAssistant(
    config,
    settings,
    store,
    { send: async (_id, text) => replies.push(text) },
    () => now,
  );
  const scheduler = new ReminderScheduler(
    store,
    async (_id, text) => {
      deliveries.push(text);
      return { kind: "sent", messageId: "666666666666666666" };
    },
    { ...settings, now: () => now + 60_000 },
  );
  try {
    await assistant.handle(createMessage("Przypomnij mi jutro o filtrze", 1));
    assert.match(replies[0], /Q1.*O której/);
    await assistant.handle(createMessage("Dodaj zadanie: kupić filtr", 2));
    assert.match(replies[1], /T1/);
    await assistant.handle(
      createMessage("!assistant remind in 1 minute | test zegara", 3),
    );
    await scheduler.tick();
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0], /R1.*\n.*test zegara/);
    await assistant.handle(
      createMessage("18:30", 4, { replyToId: "777777777777777777" }),
    );
    assert.match(replies.at(-1), /podaj ID pytania/);
    await assistant.handle(createMessage("18:30", 5));
    assert.match(replies.at(-1), /R2.*18:30.*Europe\/Warsaw/);
    await assistant.handle(createMessage("Przełóż to na wieczór", 6));
    assert.match(replies.at(-1), /Q2.*Którego dnia i o której godzinie/);
  } finally {
    await scheduler.stop();
    store.close();
  }
});
