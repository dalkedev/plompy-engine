# Personal assistant preview

Use a dedicated thread in your private Discord forum to save notes, track tasks and schedule one-time reminders. The opt-in preview ships with [Plompy 1.0.0-alpha.1](/docs/releases/1.0.0-alpha.1/). Built-in Polish and English phrases and `!assistant` commands run inside the Discord engine. The timer works while the coding worker is busy or the model is unavailable.

Start with a working [Discord engine](discord.md) installation and an owner account with access to its configured forum. Use the alpha Discord engine image for Docker. Source installations use Node.js `26.13.0` or a newer Node 26 release. The [Local MCP quickstart](quickstart.md) covers the separate tools gateway for Codex, Claude Code and OpenCode.

## Enable the preview

- Back up your deployment using the [engine snapshot procedure](https://github.com/dalkedev/plompy-engine/blob/v1.0.0-alpha.1/docs/state-backups.md).
- Create a dedicated thread in Plompy's configured private Discord forum. Check forum access for the owner, the bot and server administrators. The bot needs to read and send messages in the thread.
- Add these settings to the existing private service environment file. Replace the example thread ID and choose your time zone and delivery window.

```dotenv
PLOMPY_ASSISTANT_THREAD_ID=555555555555555555
PLOMPY_ASSISTANT_LOCALE=pl
PLOMPY_ASSISTANT_TIME_ZONE=Europe/Warsaw
PLOMPY_ASSISTANT_MAX_LATE_MINUTES=60
```

| Setting | Effect |
| --- | --- |
| `PLOMPY_ASSISTANT_THREAD_ID` | Enables the assistant and sets its only input and delivery thread. |
| `PLOMPY_ASSISTANT_LOCALE` | Sets reply language to `pl` or `en`. The default is `en`. Both sets of phrases are available. |
| `PLOMPY_ASSISTANT_TIME_ZONE` | Sets the IANA time zone for local dates and times. The default is `UTC`. |
| `PLOMPY_ASSISTANT_MAX_LATE_MINUTES` | Sets how late a reminder may be sent. Required when enabled. Use an integer from `1` to `1440`. |

For Docker Compose, run the following from your existing engine Compose project using the same private environment file, overrides and volumes. Wait for any active coding job to finish before recreating the service. The `PLOMPY_IMAGE` export supplies the alpha pin to Compose interpolation.

```sh
export PLOMPY_IMAGE=ghcr.io/dalkedev/plompy-engine:1.0.0-alpha.1
docker compose config --quiet
docker compose pull engine
docker compose up -d --no-build engine
docker compose logs --tail=50 engine
```

## Verify a reminder end to end

- Check the engine log for the `ready` event with `"assistant":true`. If startup fails, check the image pin, thread ID, bot access and required lateness setting.
- As the configured owner, send `!assistant help` in the dedicated thread. Plompy should reply with the command list.
- Send `!assistant remind in 1 minute | Check the test timer`. Plompy should return an `R` ID and due time. Wait for the reminder with that ID to appear in the same thread.
- Send `!assistant reminders` and check for **accepted by Discord** or **przyjęte przez Discorda**. This means Discord accepted the message. Whether anyone opened the thread is outside that receipt.

## Use notes, tasks and reminders

| Intent | Example |
| --- | --- |
| Save and search notes | `!assistant note Change the air filter` and `!assistant notes filter` |
| Add and complete a task | `!assistant task Order a replacement filter` and `!assistant done T1` |
| Ask in Polish | `Przypomnij mi za 5 minut o filtrze` |
| Supply a missing time | After `Przypomnij mi jutro o filtrze`, answer `18:30` in a new message if one question is open. |
| Move or cancel a reminder | `!assistant move R1 tomorrow 15:00` or `!assistant cancel R1` |
| Review open tasks or questions | `!assistant tasks` or `!assistant questions` |

Use the ID Plompy returned for your own task or reminder. When several questions are open, or when you use Discord's Reply action, answer by ID with `!assistant answer Q1 18:30`. Use a 24-hour clock. For a repeated time during a daylight saving transition, specify the offset, for example `02:30 UTC+01:00`.

The preview accepts text and supports one-time reminders. Tasks have no deadlines or recurrence. Consult the [command reference](https://github.com/dalkedev/plompy-engine/blob/main/docs/personal-assistant.md#use-the-thread) for supported phrases and forms.

## Delivery after downtime

The engine checks for due reminders every five seconds. It records a send attempt before posting to the configured thread. A move or cancellation prevents the old occurrence from posting if the send attempt has yet to start.

- **Delayed.** A reminder at least one minute late is labeled delayed if it is still within the configured delivery window. Older pending reminders are marked overdue.
- **Retry.** Known transient failures before posting and definite rate-limit rejections can be retried. The scheduler attempts delivery at most three times within the configured window.
- **Delivery uncertain.** An unknown Discord outcome or an interruption during a send can leave an uncertain result. Check the thread and reminder status before creating a replacement. Plompy leaves the uncertain attempt for review.

## Preserve state and roll back

Assistant data lives in `assistant.sqlite` under the engine's private state directory. The database is bound to its owner and thread. Reminders retain their time zone. Discord still transports the messages. Back up the assistant database separately from `agent.sqlite` with SQLite's online backup, and verify each backup before switching versions.

To disable the preview, remove `PLOMPY_ASSISTANT_THREAD_ID` from the service environment and restart or recreate the engine so it reads the new configuration. Keep the database for recovery. Before enabling the timer after restoring an old snapshot, reconcile pending reminders against the thread to avoid replaying reminders already delivered.

See the [operations runbook](https://github.com/dalkedev/plompy-engine/blob/main/docs/personal-assistant.md) for full commands, identity checks, backup and rollback.
