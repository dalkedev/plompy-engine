# Personal assistant preview

The [Plompy 1.0.0-alpha.1 prerelease](https://github.com/dalkedev/plompy-engine/releases/tag/v1.0.0-alpha.1)
adds an opt-in personal assistant to the Discord engine. The server owner can keep
notes, tasks and one-time reminders in a dedicated thread in the existing private
forum. The assistant handles supported Polish and English phrases and explicit
commands without a model call or a slot in the coding queue.

## Enable the assistant

1. Start with a working [Discord engine installation](deployment.md) in the server
   you own. Use the alpha image for Docker or the `v1.0.0-alpha.1` source tag
   on Node 26.13.0 or later within Node 26. Follow [backup and rollback](#backup-and-rollback)
   before changing versions.
2. Create a separate post in the private forum already configured for Plompy and
   copy the post's thread ID. The bot needs access to read the thread and send
   messages. Restrict forum access to the owner and bot, and review administrator
   access.
3. Add these values to the engine's private environment file. Replace the example
   thread ID. Choose the locale, time zone and delivery window for your installation.

   ```dotenv
   PLOMPY_ASSISTANT_THREAD_ID=555555555555555555
   PLOMPY_ASSISTANT_LOCALE=en
   PLOMPY_ASSISTANT_TIME_ZONE=UTC
   PLOMPY_ASSISTANT_MAX_LATE_MINUTES=60
   ```

4. Restart a single engine instance under the existing instance lock. For
   [Docker](docker.md), run these commands from the existing Compose project
   with `PLOMPY_ENV_FILE` set to that private file. Keep the existing project name
   and volumes.

   ```sh
   export PLOMPY_IMAGE=ghcr.io/dalkedev/plompy-engine:1.0.0-alpha.1
   docker compose config --quiet
   docker compose pull engine
   docker compose up -d --no-build engine
   docker compose logs --tail=50 engine
   ```

| Setting | Accepted values and behavior |
| --- | --- |
| `PLOMPY_ASSISTANT_THREAD_ID` | Thread ID inside the configured forum. Set it to enable the assistant. |
| `PLOMPY_ASSISTANT_LOCALE` | `en` (default) or `pl`. Selects reply language. |
| `PLOMPY_ASSISTANT_TIME_ZONE` | IANA time zone such as `Europe/Warsaw`. Defaults to `UTC`. |
| `PLOMPY_ASSISTANT_MAX_LATE_MINUTES` | Required when enabled. An integer from 1 to 1440 minutes after the scheduled time. |

Commands must come from the configured server owner in the selected thread.
The assistant posts replies, reminders and eligible retries to that same thread
with Discord mentions disabled.

## Verify the installation

1. Check the engine logs for the `ready` event with `"assistant":true`.
2. As the server owner, open the configured thread and type `!assistant help`.
   Expect a command list in reply.
3. Send `!assistant remind in 1 minute | Check the test timer`. Plompy replies with
   a reminder ID and due time. Wait for the separate reminder message in the thread.
4. Run `!assistant reminders` and find the same ID with status **accepted by Discord**.

If startup fails after enabling the assistant, check that the chosen ID belongs to a
thread under the configured forum and the bot can access it. Check the environment
values and ownership of any existing `assistant.sqlite` before retrying.

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

Lists display up to 12 entries. This preview accepts text and supports one-time
reminders and tasks without deadlines. Type `!assistant help` for the command list.

## Delivery and recovery

The timer checks SQLite every five seconds. When a reminder becomes due, Plompy
claims its current version and checks that it is still valid before beginning
the send attempt. Moving or cancelling it before that transition prevents the
old occurrence from being sent. After the transition, the list shows that a
send attempt has already started.

- Discord accepting the message records the receipt. The owner can see that
  delivery state without relying on the model.
- A definite rate-limit rejection or a transient error before dispatch can be
  retried, up to three total attempts within the delivery window.
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
