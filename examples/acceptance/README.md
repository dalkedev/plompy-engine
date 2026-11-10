# First goal: a small bug with an independent answer

Use this synthetic task to check a configured Szpont installation before giving it
your own project. It needs Node 24 and Git, no npm dependencies, credentials, paid
services, or network access. Initialization and verification run locally; they do
**not** connect to Discord, authenticate a provider, call a model, or prove the
worker/supervisor lifecycle. Sending the generated command in your private Discord
thread exercises your actual configured provider and consumes its usual allowance.

The task is deliberately small: a quantity parser accepts negative integers. Fix
that bug without breaking zero or changing the existing tests. It is meant to be a
first useful patch, not a benchmark against which to declare an agent intelligent.

## 1. Create a private task repository

From your trusted szpont-engine checkout:

```sh
npm run acceptance -- init --destination /absolute/private/artifacts/first-goal
```

Replace the path with a **new directory inside your configured private artifacts or
workspace**. Its parent must already exist. Use its physical/canonical path, with no
symlink ancestors, `.` or `..` segments, or trailing separator. The command refuses
an existing file/directory/symlink and never overwrites it. It also refuses private
task state inside the public szpont-engine checkout. Paths with spaces work: quote
the CLI argument according to your shell, for example:

```sh
npm run acceptance -- init --destination "/absolute/private/artifacts/first goal"
```

For Docker, run from the host using your existing Compose project, private
`SZPONT_ENV_FILE`, and selected image. Use a **container path** inside the mounted
artifacts volume:

```sh
docker compose run --rm engine acceptance init --destination /var/lib/szpont/artifacts/first-goal
```

Keep the same Compose project, environment, and volumes for initialization, the
running engine, and later verification. The image exposes this CLI through its
`acceptance` entrypoint. It prints a host Compose verification command; the normal
host installation prints `npm run acceptance` instead.

The new directory contains:

```text
first-goal/
  acceptance-manifest.json    # operator evidence, outside the bound repository
  empty-git-template/        # prevents copying the operator's Git template hooks
  repository/                # new Git root; no remotes or dependencies
    AGENTS.md
    SPEC.md
    package.json
    src/quantity.mjs
    test/quantity.test.mjs
```

The manifest, repository, and initial commit are created with synthetic data. A
partial initialization failure leaves its newly created directory for inspection;
it does not delete or reuse an uncertain destination. Choose another new destination
after inspecting the failure.

Initialization actually runs the independent checker. It must observe the expected
**RED baseline: 22/25 cases pass; three negative-quantity cases fail**. This is a
successful initialization, not a broken installation. The repository's own tests
are also intentionally RED:

```sh
cd /absolute/private/artifacts/first-goal/repository
node --test test/quantity.test.mjs
```

## 2. Send the printed goal in your private thread

Initialization prints a complete `!goal 30m --repo ...` command. Copy that exact
line. Its repository path uses JSON double quotes, including escaped characters
where needed, as required by the engine's goal parser. The task requests a fix in
`src/quantity.mjs`, unchanged tests/specification/package script, and observed test
results. The bound repository must pass the engine's normal workspace/artifacts
checks; the acceptance command does not bypass them.

Watch the real goal's status and saved diff/review evidence. A queue receipt means
queued; this kit does not infer task completion from a Discord message or a worker's
claim. No push, pull request, deployment, or public post is needed for this task.

## 3. Check independently after the goal finishes

Back in your **trusted szpont-engine checkout**, run the exact verification command
printed at initialization:

```sh
npm run acceptance -- verify --manifest /absolute/private/artifacts/first-goal/acceptance-manifest.json
```

For Docker, use the printed host command with the manifest's container path:

```sh
docker compose run --rm engine acceptance verify --manifest /var/lib/szpont/artifacts/first-goal/acceptance-manifest.json
```

Before the fix it returns JSON with `status: "FAIL"`, `check: "fixture_behavior"`,
`passed: 22`, `total: 25`, and the three negative case IDs; exit status is 1. After
an actual correct fix it returns `status: "PASS"`, `check: "fixture_behavior"`,
`passed: 25`, `total: 25`, `failed: []`; exit status is 0.

The operator's checker:

- Compares the existing test, specification, package file, and repository
  instructions byte for byte with this trusted kit; it checks the original Git
  baseline too. A normal commit of the fix is allowed.
- Imports and exercises the actual candidate parser in a fresh Node process using
  25 operator-owned cases. It never delegates its verdict to `npm test` or to the
  candidate's own test file. A zero-exit replacement test script is insufficient.
- Fails closed on missing/truncated/changed tests, a modified manifest, redirected
  repository, source symlink/hard link, malformed output, early exit, timeout, and
  excessive output. Failure JSON contains fixed check IDs, not candidate output,
  credentials, or local paths.
- Uses a restricted child environment, a four-second candidate deadline and 16 KiB
  combined output bound. It terminates ordinary child process groups on POSIX and
  requests process-tree termination on Windows. This is lifecycle hygiene, not
  arbitrary hostile-process containment.

Keep the manifest **outside the goal-bound Git root** and run the checker from an
operator-controlled installation. The manifest records fixed fixture hashes; it
cannot redefine the contract by replacing those hashes with new ones. This
separation prevents ordinary task edits from silently rewriting acceptance
evidence. It is **not a sandbox, a signature, or formal proof**: a process with your
filesystem permissions can still modify files outside its assigned repository,
including the trusted checker itself, or attempt to evade ordinary process-group
cleanup. Use this kit for its small owned fixture, not for running hostile code.

A GREEN fixture proves this parser meets the checked contract and its baseline was
preserved. It does not prove provider authentication, Discord delivery, reviewer
quality, engine recovery, or production deployment. Check those against actual
status and evidence from your own installation.
