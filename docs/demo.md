# Offline demo and README captures

The gallery is generated from the actual TypeScript `Engine` and SQLite `Store`.
It uses a temporary private workspace and synthetic Discord messages. Transport,
readiness and runner responses are scripted dependency-injection fixtures. No
coding CLI, model, Discord account, browser login or external service is called.

These are **rendered terminal transcripts**, not screenshots of a live Discord
conversation. The raw text is checked in beside each PNG so the underlying output
can be inspected without an image viewer.

## Run the scenarios

Use Node 26.13.0 or newer 26.x LTS and the locked engine dependencies:

```sh
npm --prefix apps/discord-agent ci --ignore-scripts
npm run build
npm run demo -- session
npm run demo -- recovery
npm run demo -- providers
```

Omit the mode to run all three. An invalid mode exits with usage. Temporary state
is removed on completion or failure. No deployment environment file is needed.

| Mode        | What the real engine verifies                                                                     | Transcript                                  |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `session`   | Follow-ups receive the exact saved session; another thread gets a separate session                | [Text](../assets/screenshots/session.txt)   |
| `recovery`  | A failed task blocks its queued follow-up until explicit recovery; stale follow-ups are cancelled | [Text](../assets/screenshots/recovery.txt)  |
| `providers` | Bindings survive a changed default; ready providers run while another waits                       | [Text](../assets/screenshots/providers.txt) |

The fixtures assert the relevant durable state before printing their evidence
lines. The demo's tests also check deterministic output and reject invalid modes.
A passing demo proves these engine paths with scripted dependencies; it does not
prove provider authentication, model quality, sandbox acceptance or real Discord
permissions. Private runtime data is never used as a documentation fixture.

## Regenerate the gallery

The optional capture tool has its own locked Playwright dependency; it is not
part of the production engine or Docker image.

```sh
npm run build
cd tools/docs
npm ci --ignore-scripts
npm exec -- playwright install chromium --no-shell
npm run capture
```

The capture tool runs each offline scenario, escapes its actual stdout into a
small local HTML documentation view, and screenshots that view in a temporary
headless browser context. It uses no remote fonts or images. It overwrites only
`assets/screenshots/{session,recovery,providers}.{txt,png}`.

If Chromium is already installed elsewhere, select that trusted executable
instead of downloading another browser:

```sh
SZPONT_CAPTURE_BROWSER=/absolute/path/to/chromium npm run capture
```

That browser starts with a fresh temporary profile. It does not attach to a
personal browser or reuse logged-in accounts. The committed captures were visually
checked for clipping, readable labels and the synthetic-data notice. System fonts
can vary between platforms, so byte-identical PNGs are not a portability promise.
