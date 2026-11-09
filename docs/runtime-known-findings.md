# Runtime security findings

## CVE-2026-119375: Node 24's bundled SQLite

**Open as of 2026-11-09.** Follow remediation in
[tracking issue #11](https://github.com/dalkedev/szpont-engine/issues/11). The latest
official Node 24 release, 24.22.2, embeds
SQLite 3.53.4. SQLite versions before 3.54.0 are affected by
[CVE-2026-119375](https://rustsec.org/advisories/RUSTSEC-2026-0459.html): a database
opened alongside a crafted WAL with a mismatched page size can disclose process
memory through query results. The advisory describes a local file-opening attack.
This assessment does not establish remote code execution or prove exploitability
through a Szpont command.

The engine uses Node's built-in `node:sqlite`, rather than a separately updatable
npm SQLite driver. Reinstalling npm dependencies or updating the operating system's
`sqlite3` command does not replace the copy embedded in the official Node binary.
The [official release index](https://nodejs.org/dist/index.json) listed no newer
Node 24 release at the time of this check. See the
[Node 24.22.2 release and checksums](https://nodejs.org/en/blog/release/v24.22.2).

### What the engine opens

- Normal startup opens `agent.sqlite` inside `SZPONT_STATE_DIR`. The engine creates
  and sets this state directory to mode `0700`. Use the dedicated service account
  and restrictive umask described in [deployment](deployment.md).
- Discord attachment intake accepts validated still PNG, JPEG and WebP images.
  It does not install uploaded SQLite files as engine state. This is a description
  of the engine's transport, not a restriction on arbitrary tasks an operator
  authorizes a coding agent to perform.
- The operator-only [snapshot tool](state-backups.md) accepts a raw SQLite source
  path. It opens that source, including any existing sidecars, before inspecting
  its schema and integrity. Both backup and restore therefore require trusted
  input provenance. Do not open a database or sidecars supplied by an untrusted
  party, including after copying them into an owned private directory.

Private ownership reduces who can replace state; it does not fix SQLite, establish
file provenance, or isolate another process running as the same account or root.
Read-only opening, `trusted_schema=OFF`, schema checks and integrity checks are
not a fix for this memory-safety issue: they already invoke the SQLite parser.
Keep backups and their directories private and use only snapshots from your own
trusted deployment.

### Verification and remediation gate

Inspect the runtime actually used by the service, without opening any database:

```sh
node -p 'JSON.stringify({node:process.versions.node,sqlite:process.versions.sqlite})'
```

A checksum-verified official macOS arm64 Node 24.22.2 binary was extracted and run
in an isolated directory. Both `process.versions.sqlite` and an in-memory
`SELECT sqlite_version()` returned `3.53.4`.

The Dockerfile pins `node:24.22.2-bookworm-slim` to the immutable index digest
`sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`.
A refreshed mutable tag or successful application CI does not demonstrate that
its embedded SQLite is patched. No Docker runtime was executed during this check.

Keep this finding open until a supported official Node 24 release includes SQLite
3.54.0 or newer, or the Node project documents a backport of this specific fix.
Check the actual shipped binary on supported platforms and both Docker image
architectures. Then update the immutable image pin, run the engine and snapshot
regressions, and stage a backed-up deployment before switching it. Do not replace
the runtime with an unreviewed major upgrade or a custom SQLite/Node rebuild.

Upstream references:

- [SQLite 3.54.0 release](https://sqlite.org/releaselog/3_54_0.html)
- [SQLite fix](https://github.com/sqlite/sqlite/commit/e5bf119821f25be1d7f10ef0a2edbe175289166e)
- [Node 24.22.2 embedded SQLite header](https://github.com/nodejs/node/blob/v24.22.2/deps/sqlite/sqlite3.h)
- [Supported Node releases](https://nodejs.org/en/about/previous-releases)
