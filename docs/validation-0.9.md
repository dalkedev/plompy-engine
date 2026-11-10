# 0.9 installation validation

Recorded on 2026-11-10. This is a bounded release record, not a 1.0 reliability
certificate. The immutable release tag and its Actions run identify the published
source and native OCI artifacts. This record contains synthetic results only.

## Automated checks

- macOS, Node 24.22.2: 564 passing engine/script tests; one Linux-only sandbox
  test is skipped on macOS. Linux CI runs that platform check.
- The 55 permission/snapshot integration tests pass under both `umask 0022` and
  `0077`. Three intentionally permissive fixtures first reproduced failures under
  `0077`; explicit fixture modes fixed them without changing production guards.
- Five real Discord SDK cache regressions protect fresh owner/role validation.
  Before the fix, four cases failed. Transport plus doctor parity checks pass 43/43.
- Browser CI passes 36 offline tests with hash-locked dependencies.
- Native `amd64` and `arm64` container smoke runs without networking or credentials,
  with a read-only application filesystem. It exercises the real Codex sandbox,
  the actual pinned CLI version, setup, offline doctor, persistent synthetic SQLite
  state and independent acceptance checker controls.
- Public-tree hygiene and Gitleaks checks cover the release changes. Docker uses
  an explicit source allowlist; no private workspace or authentication is packaged.

The supplied parser fixture starts at 22/25 passing cases. A controlled implementation
fix reaches 25/25; changed tests or evidence are rejected. That smoke fix tests the
checker, not model execution.

## Existing Linux host, separate installation

A fresh public clone was installed and built as the dedicated service user, using
new workspace/state/artifact/browser directories. Token-stdin setup succeeded
without echoing the credential. A real, opt-in Discord REST doctor passed bot
identity, guild owner, forum privacy and effective reply permissions. The actual
installation smoke passed using Codex CLI 0.166.0.

A separate public engine connected to a dedicated private lab forum. A real owner
message was accepted, queued, started and received a failure receipt in that same
thread. This live attempt exposed an incomplete Gateway guild-cache startup bug;
fresh guild REST data fixed the false owner mismatch while retaining authorization.
The production service and its queue were not restarted or migrated by this test.

The isolated engine reused an existing authentication home in place; no credential
profile was copied. That profile requires a private MCP server available only in
its original job context. The public lab correctly failed before creating a model
session when that server could not initialize. No fixture fix or proof file was
produced. The lab process was then stopped; its failed job was not automatically
replayed.

**NOT RUN successfully:** public model task completion, same-session continuation,
model-driven fixture/supervisor acceptance, non-owner human rejection, live restart
recovery, a completely fresh VPS/account, and multi-day soak. These remain deployment
and [1.0 gates](../ROADMAP.md), not conclusions from offline or REST checks.

## Independent audit and environment limit

The private agent reviewed a separate public clone with synthetic files and receipts.
It verified build, the permission-fixture corrections, expected parser RED, a focused
production fix, independent GREEN, and rejection of weakened tests.

Its full installation suite ran inside an agent user namespace that projected trusted
host ancestor owners to overflow UID 65534. Fifteen setup tests failed at the ancestor
trust check before reaching their intended branches. A same-UID probe outside that
namespace confirmed the original root ownership; direct host setup passed separately.
The installer guard was retained. Run setup and filesystem acceptance in the normal
service-account host or supported image, as described in [setup](setup.md#execution-environment).
Do not report this sandbox audit as a complete host-installation PASS.

## Retained known finding

Node 24.22.2 embeds SQLite 3.53.4 and remains subject to the documented crafted local
DB/WAL finding. This release does not claim a patched runtime. See
[runtime known findings](runtime-known-findings.md) and
[issue #11](https://github.com/dalkedev/szpont-engine/issues/11).
