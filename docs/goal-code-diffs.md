# Code diffs for supervised goals

For a practical walkthrough, see [your first supervised code goal](first-goal.md).

Bind the actual code repository when starting a goal:

```text
!goal 30m --repo /var/lib/plompy/artifacts/app Fix the parser and verify regressions.
!loop 2h --repo "/var/lib/plompy/artifacts/My App" Implement the agreed change.
```

The path must be the Git repository's root, inside the configured workspace or
artifacts directory. Authentication, browser profiles, engine state and their
ancestors cannot be bound. Paths with spaces use JSON double quotes. The engine
canonicalizes and stores the binding; `!goal status` shows it. This does not add
filesystem permissions or change the runner's sandbox.

Goals without a repository keep their existing behavior. The supervisor is told
that automatic code evidence is unavailable; the engine does not scan all projects
or mistake its Markdown memory repository for the requested codebase. Existing
schema-5 goals migrate without an implicit binding. Supervised goals still require
Codex; ordinary `!work` and other runner adapters are unchanged.

## What the supervisor receives

Before each worker phase, the engine saves a bounded filesystem snapshot of the
bound repository. After the worker returns, it captures the new contents and seals
an observed patch with the candidate. It compares the contents **before and after
that phase**, independently of Git HEAD. Committing or staging inside the step
does not hide changed code or assertions. Preexisting dirty contents are part of
the baseline, rather than automatically attributed to the worker.

The supervisor receives before/after content hashes, HEAD identifiers, changed
paths, a bounded patch excerpt and an exact private evidence-file path. The saved
JSON includes its own completeness/omission metadata. Two recent candidate/review
receipts provide bounded context across fresh supervisor sessions. Files, patch
text and historical model summaries remain untrusted data, never new authority.

The reviewer should inspect code and tests against the fixed goal. Test-only
changes can be correct; weakening an assertion cannot establish a behavior fix.
The engine does not mechanically fail every test-only change or equate a model
review with passing tests.

Each next worker phase gets a fresh baseline. If its content/coverage hash differs
from the prior after-snapshot, the reviewer receives a drift notice. Intervening
changes are excluded from that step patch. Snapshots show observed contents and
are not an authorship guarantee: other processes may edit the same repository.
Use isolated working copies for independent goals.

## Capture boundary and limits

The inventory includes tracked files and nonignored untracked files. Previous
paths are rechecked after the worker, even if a new ignore rule would hide them.
Initially ignored files are not newly discovered; a previously observed path
remains in scope if ignore rules change. Common credential paths are omitted
without reading their contents; this is not a comprehensive secret detector.
Do not put credentials into source code. All evidence remains private and must
stay outside the public repository, releases and container build context.

- At most 1,024 paths; up to 512 KiB per file and approximately 3 MiB read per capture.
- At most 4 MiB per serialized snapshot, 96 KiB of patch text and 256 KiB per saved evidence record.
- Git commands have a five-second deadline; capture/render processing uses a ten-second monotonic limit.
- Binary files get hashes/metadata, not inline binary content. Symlink targets are recorded without following them. Hard-linked and unsafe paths are omitted.
- Invalid filename encoding, changed roots, replaced directory identities and unsafe traversal are rejected. Limits, binary/sensitive paths, races and truncation are explicit.

A partial or unavailable capture is **not an empty or clean diff**. Both the prompt
excerpt and the saved record can be incomplete. The reviewer must assess gaps
relevant to the goal rather than silently treating missing coverage as success.

The engine never stages, stashes, resets or writes into the source repository to
capture a diff. Git filters, external diff programs and filesystem-monitor helpers
are disabled. Text patches are rendered in private temporary files outside the
repository, with no source hooks or text conversion. These checks assume a trusted
service account; they are not isolation from a malicious process with the same UID.

## Persistence, pause and recovery

SQLite is authoritative. The baseline is committed before the worker starts;
its patch and candidate are committed together with measured execution time.
Completed captures discard the bulky baseline while retaining sealed evidence.
If the post-worker capture fails, the candidate is saved with explicit unavailable
evidence, never replaced with a fictitious clean patch.

Pause/resume and reviewer recovery retain the same sealed record. Later live
changes cannot replace the patch on a reviewer retry. An uncertain worker attempt
requires explicit reconciliation and gets a fresh baseline when execution resumes.
Legacy pending candidates without code evidence remain recoverable without replay.

An explicit fresh budget in a blocked thread retains the repository binding when
no new `--repo` flag is supplied. The same fixed goal and binding can carry a saved
candidate and its evidence forward. Changing either discards the stale candidate;
`--no-repo` explicitly detaches capture. History and prior charged time remain.
Use a fresh `!goal` command to change this binding; repository flags inside a
plain `!recover` note do not reconfigure it. For example:

```text
!goal 30m --no-repo Continue the agreed non-code investigation.
```

Derived private review JSON files are regenerated from committed SQLite evidence.
They are published without overwriting a different receipt. Backups therefore
retain the existing single-database contract; derived files are not the backup
authority.

## Upgrade

Version 0.8.0 migrates public SQLite schemas 0–5 to **schema 6**, adding a nullable
goal repository and durable code evidence. Take a coordinated
[state snapshot](state-backups.md) and matching workspace checkpoint before upgrade.
Version 0.7.0 rejects schema 6. Rollback requires its compatible pre-upgrade state
and reconciliation of subsequent actions; never lower `user_version` or delete
evidence tables to make an older binary accept migrated state.
