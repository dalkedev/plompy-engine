# Releases and container images

Browse the [public release history](https://plompy.dev/docs/releases/) for a page per published version. This guide covers distribution, upgrades and the maintainer workflow.

A release is a versioned public source snapshot and a set of container images. It does not update an existing private deployment automatically. The [changelog](../CHANGELOG.md) records user-visible changes; the [Docker guide](docker.md) explains initial setup and private volumes.

## Choose an image

Version 0.13.0 publishes three separate variants, each for Linux `amd64` and `arm64`:

| Image | Purpose |
| --- | --- |
| `ghcr.io/dalkedev/plompy-engine:0.13.0` | Existing Discord engine with its Codex runner |
| `ghcr.io/dalkedev/plompy-engine:0.13.0-local` | Local MCP tools for an independently running host agent |
| `ghcr.io/dalkedev/plompy-engine:0.13.0-local-browser` | Local MCP tools plus sandboxed, read-only Chromium |

For Local mode, download [plompy-local-0.13.0.tar.gz](https://github.com/dalkedev/plompy-engine/releases/download/v0.13.0/plompy-local-0.13.0.tar.gz) and follow the [Docker quickstart](local/quickstart.md). The kit includes pinned Compose configuration, browser security profiles and client examples. It needs no source checkout or host Node installation. Local mode does not include a model or agent login.

## Pull the Discord engine

```sh
docker pull ghcr.io/dalkedev/plompy-engine:0.13.0
docker buildx imagetools inspect ghcr.io/dalkedev/plompy-engine:0.13.0
```

The release workflow publishes Linux `amd64` and `arm64` variants. A stable release publishes an exact version tag, a minor-series tag, `latest`, and `sha-<first 12 characters of commit>`. For example, `v0.6.1` produces `0.6.1`, `0.6`, `latest`, and its revision tag. A prerelease such as `v0.7.0-rc.1` publishes only its exact prerelease and revision tags; it cannot move `latest` or a stable minor-series tag.

Local variants use matching suffixed tags such as `0.13.0-local`, `0.13-local`, `latest-local` and `sha-<revision>-local`. Browser tags end in `-local-browser`. They never move the unsuffixed Discord engine aliases.

Tags are convenient aliases. For repeatable deployments, copy the full `ghcr.io/dalkedev/plompy-engine@sha256:...` reference from the successful workflow summary or manifest inspection and pin that digest in your deployment. The OCI labels identify the source repository, exact revision, version, and MIT license. The published image also includes BuildKit provenance and an SBOM.

The unsuffixed Discord engine image contains no browser profile or real account session. Version 0.13.0 packages and verifies **Codex only** inside that engine; it rejects `PLOMPY_RUNNER=claude` and `opencode` before initialization writes. Claude Code and OpenCode are [experimental host adapters](runners.md), requiring their own installed CLI, private authentication, permissions and acceptance checks. The optional Camoufox desktop/browser service is outside this image. A release does not supply model access or account allowances.

Version 0.5.0 introduced [private Discord image input](image-input.md) for Codex, including
resumed turns. The other host adapters explicitly reject images. SQLite snapshots
now include attachment bytes; keep them private. Version 0.6.0 added [guided integration setup](integrations.md) and recovery that can
continue the saved session with a fresh, explicit work budget. It retains schema 4
and does not alter a private deployment or backport its custom integrations.

Version 0.6.1 adds `!queue` for current-thread waiting reasons and fixes status, result
readback and recovery suggestions to use durable acceptance order when the host clock
moves backwards. It does not introduce another worker or a state migration.

## Maintainer release process

1. Prepare the intended changes in a reviewed pull request. Keep all real state and owner material outside the source tree.
2. Set the same version in the root `package.json`, `apps/discord-agent/package.json`, both root-version fields of `apps/discord-agent/package-lock.json`, `packages/local-mcp/package.json` and both root-version fields of its lockfile, `packages/browser/pyproject.toml`, the `__version__` constant in `packages/browser/src/plompy_browser/__init__.py`, and the `plompy-browser` project entry in `packages/browser/uv.lock`. Set both Dockerfile `VERSION` defaults and the Discord Compose image default to the same release version. Update `CHANGELOG.md` with the actual changes and date. Check the Python lock with `uv lock --check --offline` from `packages/browser`.
3. Review the diff and wait for the normal checks on the exact pull-request head. Run the container smoke test locally when Docker is available, then merge normally and verify the resulting `main` commit before tagging.
4. Create and push a fresh version tag on that commit. Never move an existing release tag.

```sh
git switch main
git pull --ff-only
git tag -a v0.13.0 -m 'Plompy Engine 0.13.0'
git push origin refs/tags/v0.13.0
```

The [release workflow](../.github/workflows/release.yml) runs only on `v*` tag pushes. It first requires the tagged commit to be reachable from `main`, validates all package and project-lock versions, checks the public tree, and runs the locked engine and browser suites. Each engine, Local core and Local browser variant is built and checked on native amd64/arm64 runners. Each runner builds its OCI archive once, including provenance and an SBOM, and loads that archive's runtime for the offline smoke test. A configuration-digest check binds the loaded runtime (including its filesystem layer identities) to the OCI archive. Runtime state is created in throwaway volumes and is never included in the archive.

The workflow also builds the allowlisted Local starter kit and its SHA-256 checksum, without including source state or credentials. The original tested OCI archives and their digest reports are retained as workflow artifacts for one day. A separate publishing job receives `packages: write` after all checks succeed. It revalidates the archive hashes, labels, runtime and attestation subjects, copies every manifest with `skopeo --preserve-digests`, and combines the unchanged amd64/arm64 runtime and attestation manifests into the release index. It does not rebuild the application or reinstall its dependencies. The final index is checked against the complete tested manifest set before its digest is recorded. Publishing uses the job's short-lived GitHub token; no personal registry token is needed. If retained artifacts have expired, rerun the complete workflow so both architectures are rebuilt and retested.

After the workflow succeeds, inspect the published manifest and digest, pull the exact images without authentication to confirm public availability, and create the GitHub release with the relevant changelog entry and immutable image references. Attach the generated Local starter kit and its checksum. Then refresh the [release-history catalog](releases/README.md) and rebuild the website documentation from the canonical changelog. The workflow deliberately does not create a release announcement before the image has been verified. GitHub may initially create a GHCR package as private; check its package visibility for the first publication before documenting anonymous installation.

The tag validator accepts SemVer versions with an optional prerelease, without build metadata (`+...`, which is not a Docker tag character). Release metadata and tag-selection behavior have their own offline test:

```sh
node --test scripts/release-metadata.test.mjs scripts/release-oci.test.mjs scripts/package-local-release.test.mjs
```

Official references: [Docker OCI exports](https://docs.docker.com/build/exporters/oci-docker/), [BuildKit attestations](https://docs.docker.com/build/ci/github-actions/attestations/), [digest-preserving Skopeo copy](https://github.com/podman-container-tools/skopeo/blob/main/docs/skopeo-copy.1.md), [manifest composition](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/), and [GitHub package publishing](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Upgrade and rollback

Record the current image digest and stop the engine before taking a coordinated backup of its private state and workspace. Keep runner authentication and browser-profile backups private and separate. Start the desired pinned image with the same configured volumes, then inspect its logs and queue status before sending a synthetic owner task. A successful image build or offline smoke test does not establish Discord connectivity, account validity or live model access.

Do not run two engine instances against the same SQLite state at once. Version 0.13.0 uses **schema 6** and migrates public schemas 0–5 to that schema, retaining saved candidates, reviews and code-diff evidence. Existing provider bindings and sessions are preserved; pre-schema-3 jobs and conversations retain Codex bindings, including conversations whose session has not started; changing `PLOMPY_RUNNER` never converts them to another provider. New threads use the configured default. Session reset retains the thread's provider, and recovery retains the original job's provider.

| Engine version | Public SQLite schema |
| -------------- | -------------------- |
| 0.2.x          | 0                    |
| 0.3.0          | 1                    |
| 0.3.1          | 2                    |
| 0.4.0          | 3                    |
| 0.5.0–0.6.1    | 4                    |
| 0.7.0          | 5                    |
| 0.8.x–0.13.x   | 6                    |

Before upgrading, create and verify a pre-upgrade snapshot using the [state backup guide](state-backups.md), and retain the matching workspace checkpoint and image digest. The 0.4.0 engine rejects schema 4, and 0.3.x rejects schema 3 and later. To roll back across an incompatible schema, stop the current engine, restore the compatible pre-upgrade snapshot into a new private state location, reconcile jobs and external actions accepted after that snapshot, and switch the matching binary and workspace together. Never lower `PRAGMA user_version` or remove provider columns or image tables as a downgrade shortcut.

Versions 0.5.0 through 0.6.1 share schema 4, but a rollback still requires reviewing recovery jobs and external actions accepted by the newer engine. Retain a coordinated pre-upgrade snapshot, workspace checkpoint and image digest rather than treating schema compatibility as an automatic replay guarantee.

The 0.2 engine predates the version guard and cannot preserve later workflow or provider semantics. It must never open migrated state. A rollback restores earlier database contents; it does not undo files, posts, deployments or other external effects. Public and private-deployment databases are not interchangeable.

## Supervised goals in 0.7.0

Version 0.7.0 adds [`!goal` / `!loop`](supervised-goals.md). Retain a pre-upgrade
schema-4 snapshot for rollback to 0.6.1; a 0.6.1 binary cannot open schema 5.
The [validation record](verification/2026-11-07-supervised-goals.md) distinguishes
offline checks from actual CLI and deployment acceptance.

## Repository evidence in 0.8.0

[Owner-bound code diffs](goal-code-diffs.md) compare actual working-tree contents
across a worker step. They survive reviewer recovery and do not rely on HEAD
remaining unchanged. Capture limitations remain explicit. Schema 6 retains this
private evidence in SQLite; 0.7.0 and earlier reject it.

## Queue capacity in 0.8.1

A paused supervised goal now obeys the same shared 30 queued/running-job limit
as new intake. If capacity is full, it stays paused with its saved candidate and
remaining budget intact. Check `!queue` and retry `!goal resume` after a slot is
available; do not create a new goal just to resume it. This patch retains schema
6 and does not alter private deployments automatically.

## Node 26 LTS in 0.10.0

Version 0.10.0 requires Node 26.13.0 or a newer 26.x LTS release with linked SQLite
3.54.0 or newer. This replaces Node 24 support to remediate the embedded SQLite
finding; it does not migrate schema 6, reset runner sessions or renew job budgets.
Use the [runtime finding record](runtime-known-findings.md) and verify the actual
service binary, not only the Node found in an operator's interactive shell. Linux
Node 26 binaries also require libatomic; provision host prerequisites explicitly.
The published supported image includes its required runtime libraries.


## Provider tools in 0.11.0

The integrations menu now offers Playwright, Perplexity, Firecrawl, TinyFish and
PostHog for Codex, Claude Code and OpenCode. Host browser tooling is optional and
pinned; the Docker image includes the small API-key MCP bridge but no browser.
Native OAuth uses the selected runner's own login. API-key mode reads a dedicated
private credential file without placing its contents in the registry, command
arguments or the runner's environment. PostHog requests server-side read-only mode.

Use the [integration guide](integrations.md) for installation and authentication.
Configuration inspection and offline tests do not prove a live vendor login or
API entitlement. External service quotas and billing remain separate. This
release retains schema 6 and does not change recovery, session bindings or the
Codex-only supervised workflow boundary.
