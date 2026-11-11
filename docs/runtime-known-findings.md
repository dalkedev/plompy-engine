# Runtime security findings

## CVE-2026-119375: remediation in 0.10.0

Version 0.10.0 moves to **official Node 26 LTS, at least 26.13.0 and below 27**.
Node 26.13.0 embeds SQLite **3.54.0**, which contains the upstream fix for
[CVE-2026-119375](https://rustsec.org/advisories/RUSTSEC-2026-0459.html).
Node 24 is no longer supported by this release. This is a runtime requirement
change, not an update to an npm SQLite driver or the host's `sqlite3` command.

The vulnerability concerns opening a database beside a crafted WAL whose page
size is smaller than the database's. Ordinary queries can disclose uninitialized
page-cache memory. The vector requires opening files a less-trusted party could
supply; no Plompy remote exploit or standalone code-execution claim was established.
The upstream fix zero-initializes the unread buffer tail. Do not describe it as
rejecting every mismatched WAL.

### Runtime enforcement

Startup and Store construction validate the Node version and linked SQLite before
opening a filesystem database. Setup and the standalone snapshot tool use the same
policy. The required doctor checks distinguish Node support from SQLite support.
SQLite metadata must agree with a fresh in-memory `SELECT sqlite_version()` result;
missing, inconsistent or older linked versions are refused. A Node-major check
alone is not remediation evidence.

Use only official supported binaries. A custom runtime can misrepresent its own
metadata; these checks do not replace archive checksums or OCI identity checks.
An undocumented vendor backport is not implicitly accepted by this version policy.

```sh
node -p 'JSON.stringify({node:process.versions.node,sqlite:process.versions.sqlite})'
npm run doctor
```

The image pins both stages to
`node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`.
Release validation checks the actual linked SQLite on native amd64 and arm64 images
and promotes the tested OCI bytes without rebuilding. The package types, CI,
installation instructions and local version files use the same Node 26 contract.

### Upgrade and private state

Public SQLite schema remains **6**. Back up state, workspace and enabled runner
session storage together before upgrading. Stage the new binary as the dedicated
service user, run the complete regression suite and WAL/snapshot/restore checks,
then drain active work before switching the service. Keep a verified rollback
binary and coordinated backup; do not rewrite schema metadata or replay uncertain
jobs to make a downgrade work. See [deployment](deployment.md),
[state backups](state-backups.md) and [releases](releases.md).

The transport accepts validated still images, not raw databases as engine state.
The operator snapshot tool does accept raw database paths and opens their sidecars.
Continue accepting only your trusted state/backup provenance. File ownership does
not establish where file contents came from.

### Historical affected releases

The Node 24.22.2 runtime shipped by 0.9.x and earlier embeds SQLite 3.53.4 and remains
affected. On 2026-11-10 the official Node index still listed 24.22.2 as the latest
Node 24 release; the actual embedded source did not contain this fix. Existing
images and private installations do not acquire remediation from a new README or
an npm install. They need a verified runtime and service upgrade.

Checksum-verified official macOS arm64 and Linux x64 Node 26.13.0 binaries both
reported SQLite 3.54.0 through runtime metadata and an in-memory SQL query during
migration preparation. The previous Node 24 binary reported 3.53.4.

Upstream references:

- [Node 26.13.0 LTS release and checksums](https://nodejs.org/en/blog/release/v26.13.0)
- [Official Node release index](https://nodejs.org/dist/index.json)
- [Node 26.13.0 embedded SQLite header](https://github.com/nodejs/node/blob/v26.13.0/deps/sqlite/sqlite3.h)
- [SQLite 3.54.0 release](https://sqlite.org/releaselog/3_54_0.html)
- [SQLite fix](https://github.com/sqlite/sqlite/commit/e5bf119821f25be1d7f10ef0a2edbe175289166e)
- [Tracking issue #11](https://github.com/dalkedev/plompy-engine/issues/11)
