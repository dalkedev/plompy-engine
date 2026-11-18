# Personal assistant preview

Plompy 1.0.0-alpha.1 can keep notes, tasks, and one-time reminders in a dedicated
thread in the existing private Discord forum. The assistant recognizes built-in
Polish and English phrases and explicit commands. It handles those operations
without sending the conversation to a model or occupying the coding worker.

## Enable the assistant

1. Use the supported public engine on Node 26.13.0 or later within Node 26. Verify
   compatibility and backups before changing a private fork or its runtime.
2. Create a separate thread in the private forum already configured for Plompy.
   Restrict forum access to the owner and bot, and review server administrator
   access. The bot must be able to read the thread and send messages.
3. Add the following to the private service environment file. Replace the
   synthetic ID and select your locale, IANA time zone, and lateness window.

   ```dotenv
   PLOMPY_ASSISTANT_THREAD_ID=555555555555555555
   PLOMPY_ASSISTANT_LOCALE=en
   PLOMPY_ASSISTANT_TIME_ZONE=UTC
   PLOMPY_ASSISTANT_MAX_LATE_MINUTES=60
   ```

4. Start the tested version under the existing instance lock. With Compose, use a
   single engine service and set `PLOMPY_IMAGE` to the tested alpha image or build
   the alpha checkout. Use the same private environment file as the service.
5. Check the startup event for `"assistant":true`. To test the feature, the
   owner can save a synthetic note, ask for a reminder tomorrow, then answer
   the follow-up with a time. For a short reminder use
   `!assistant remind in 1 minute | Check the test timer`.

Keep the assistant in its own thread. The server owner and configured forum
are checked using the engine's existing identity settings. The assistant uses
its chosen thread for incoming commands and every delivery, including retries.
Discord mentions are disabled for replies and reminders.

## Use the thread

| Request | Explicit form |
| --- | --- |
| Save a note | `!assistant note Ideas for the garden` |
| List or search recent notes | `!assistant notes` or `!assistant notes garden` |
| Add a task without a deadline | `!assistant task Buy a new filter` |
| See open tasks or complete one | `!assistant tasks` or `!assistant done T1` |
| Schedule a reminder | `!assistant remind tomorrow 14:30 \| Change the filter` |
| Move or cancel a reminder | `!assistant move R1 tomorrow 15:00` or `!assistant cancel R1` |
| See reminder and delivery status | `!assistant reminders` |
| See or close unresolved questions | `!assistant questions` or `!assistant question-cancel Q1` |
| Answer a question by ID | `!assistant answer Q1 14:30` or `!assistant answer Q1 2030-06-10 14:30` |

For example, write “Przypomnij mi jutro o filtrze”. Plompy saves the open
question and asks for a time. Send a new message with “18:30” if exactly one
question is open. Include the question ID when using Discord's Reply button
or when several questions are open. You can add another
task while a question is open. “Zrobione” completes a task if there is exactly
one open task. Use the ID if several tasks are open.

Relative dates use your time zone and the creation time on the Discord
message. Use a 24-hour time. For a repeated hour at the end of daylight
saving time, give the matching offset explicitly, for example
`02:30 UTC+01:00`. For a skipped hour, choose a different time.

This preview handles the supported phrases and commands. Lists display up to
12 entries. The command help is always available as `!assistant help`.

## Delivery and recovery

The timer checks SQLite every five seconds. When a reminder becomes due, Plompy
claims its current version and checks that it is still valid before beginning
the send attempt. Moving or cancelling it before that transition prevents the
old occurrence from being sent. After the transition, the list shows that a
send attempt has already started.

- Discord accepting the message records the receipt. The owner can see that
  delivery state without relying on the model.
- A definite rate-limit rejection can be retried, up to three total attempts.
  An uncertain send or crash during a send becomes **delivery uncertain**.
  Check the thread before replacing an uncertain reminder.
- After downtime, reminders within the configured window can still be sent.
  Reminders at least one minute late are labeled delayed. Older reminders are
  marked overdue and stay available through the reminder list.
- Removing `PLOMPY_ASSISTANT_THREAD_ID` and restarting disables the assistant
  and its timer. Its data stays on disk. The public preview only sends reminders
  the owner requested.

## Backup and rollback

Assistant state lives in `assistant.sqlite` under the private
`PLOMPY_STATE_DIR`. The database identifies its owning Discord thread and
refuses to open under a different owner or thread. Keep it and its sidecars
under the service account's private directory.

Before switching versions, follow the existing [engine snapshot procedure](state-backups.md)
for `agent.sqlite` and take a separate SQLite online backup of
`assistant.sqlite`, such as with the SQLite CLI's `.backup` command, to a new
private destination. Verify the backup with `PRAGMA integrity_check` and keep
the code, configuration, and compatible state together. The engine snapshot
tool is for the coding database. Copying a main SQLite file while its WAL is
active can omit committed records.

For rollback, stop the tested release before starting an older release under
the instance lock. Preserve the assistant database for later use. If you
restore an earlier assistant snapshot, reconcile its pending reminders against
the Discord thread before enabling its timer, since some reminders might have
been sent after that snapshot.
