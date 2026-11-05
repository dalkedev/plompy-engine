# Discord image input

In a private Codex thread, attach still PNG, JPEG or WebP images to a normal message.
A caption describes what to inspect; an image-only message asks Szpont to inspect the
attachments. Images can also accompany an explicit `!work 30m <goal>` command.

The engine passes image files through native `codex exec --image` input, including
`codex exec resume --image` for an existing session. It does not rely on a model
reading a path mentioned in a text prompt. The configured Codex model must support
image input. A model or CLI rejection fails the turn; it does not downgrade the
request to text-only input or select another model. Claude Code and OpenCode image input is
not implemented by these adapters: those threads receive an explicit rejection
before a download or queue insertion. The engine never switches runners to handle
an image. Select Codex for a new thread or send a text-only request.

## Accepted files and limits

| Boundary | Limit |
| --- | --- |
| Files per message | 4 |
| Each file | 8 MiB |
| Combined files | 20 MiB |
| Media types | Still `image/png`, `image/jpeg`, `image/webp` |
| Canvas | At most 16,384 pixels per side and 25 million pixels total |
| Download time | 15 seconds for the entire batch |
| Source | HTTPS `cdn.discordapp.com` or `media.discordapp.net`, attachment path matching the verified thread and attachment ID |

Other attachments, GIF, SVG, animated PNG/WebP and external image URLs are rejected.
Declared metadata, HTTP media type and length, streamed bytes, file signatures and
canvas dimensions must agree. These checks bound intake; they do not replace the
runner's image decoder. Redirects are rejected, including redirects to another CDN.
No Discord token, cookies or credentials are sent with the download request.

Owner, guild, bot/webhook and forum-thread authorization occurs before downloading.
The engine validates the whole batch's metadata and URLs before its first request.
A failed file rejects the entire message; partial batches are never queued. Intake
is serialized so a later message cannot overtake a pending image download. Shutdown
aborts that download and does not admit the remaining pending messages. Wait for
the queued notice or check `!status` to establish durable acceptance.

Commands such as `!status`, `!recover` and `!new-session` must be sent without
attachments. They receive an explicit rejection when images are attached; the
service does not silently discard those images and execute the command.

## Private persistence and recovery

Schema 4 stores image bytes, MIME types and SHA-256 digests in SQLite alongside the
job in one transaction. Queued jobs survive restart without downloading expiring
CDN links again. Workflow steps and manual recovery retain their original images
and exact provider/session binding. A corrupt saved digest fails before model
execution. Attachments remain untrusted data rather than a source of authority.

At execution time, the worker writes files into a generated `0700` directory under
`SZPONT_STATE_DIR`; individual files have mode `0600`. The engine removes them after
success, failure, timeout or cancellation. Startup removes abandoned generated
image directories left by a killed process. As with startup recovery, this requires
the deployment's external singleton lock **before Node starts**; never run a second
engine against a live state directory. Directory aliases and unrelated files are
not followed or deleted.

Original CDN URLs, filenames, binary data and temporary paths are not added to
readable Markdown transcripts or automatic memory commits. A transcript records
only the attachment count. A model's answer can still describe image contents;
responses and any deliberate model-authored notes remain private conversation data.
Image bytes are retained with job history, including cancelled and failed jobs;
there is no automatic retention or pruning policy. Account for up to 20 MiB per
image-bearing job and additional copies made by manual recovery.

The [state snapshot tool](state-backups.md) includes all image bytes and metadata
in its verified SQLite backup. Protect those backups as private images as well as
private prompts. Runner login/session stores, browser profiles, private workspace
files and generated artifacts remain separate backups.

## Upgrade boundary

Version 0.5.0 migrates public schema 3 to schema 4 while preserving existing jobs,
results, provider bindings and sessions. Older public schemas follow their existing
migrations first. Take a verified pre-upgrade snapshot before starting the new
engine. Version 0.4.0 rejects schema 4; rollback requires its compatible snapshot,
a matching workspace checkpoint and reconciliation of later external actions.
A release does not upgrade an existing private deployment automatically.
