# Releases and container images

A release is a versioned public source snapshot and a container image. It does not update an existing private deployment automatically. The [changelog](../CHANGELOG.md) records user-visible changes; the [Docker guide](docker.md) explains initial setup and private volumes.

## Pull a release

```sh
docker pull ghcr.io/dalkedev/szpont-engine:0.2.0
docker buildx imagetools inspect ghcr.io/dalkedev/szpont-engine:0.2.0
```

The release workflow publishes Linux `amd64` and `arm64` variants. A stable release publishes an exact version tag, a minor-series tag, `latest`, and `sha-<first 12 characters of commit>`. For example, `v0.2.0` produces `0.2.0`, `0.2`, `latest`, and its revision tag. A prerelease such as `v0.3.0-rc.1` publishes only its exact prerelease and revision tags; it cannot move `latest` or a stable minor-series tag.

Tags are convenient aliases. For repeatable deployments, copy the full `ghcr.io/dalkedev/szpont-engine@sha256:...` reference from the successful workflow summary or manifest inspection and pin that digest in your deployment. The OCI labels identify the source repository, exact revision, version, and MIT license. The published image also includes BuildKit provenance and an SBOM.

The engine image contains no browser profile or real account session. It includes the Codex CLI, whose authentication and usage allowance you provide separately. The optional Camoufox desktop/browser service is outside this image.

## Maintainer release process

1. Merge the intended changes into `main`. Keep all real state and owner material outside the source tree.
2. Set the same version in the root `package.json`, `apps/discord-agent/package.json`, both root-version fields of `apps/discord-agent/package-lock.json`, `packages/browser/pyproject.toml`, and the `szpont-browser` project entry in `packages/browser/uv.lock`. Update `CHANGELOG.md` with the actual changes and date. Check the Python lock with `uv lock --check --offline` from `packages/browser`.
3. Wait for the normal checks on the exact commit. Review the diff and run the container smoke test locally when Docker is available.
4. Create and push a fresh version tag on that commit. Never move an existing release tag.

```sh
git switch main
git pull --ff-only
git tag -a v0.2.0 -m 'Szpont Engine 0.2.0'
git push origin refs/tags/v0.2.0
```

The [release workflow](../.github/workflows/release.yml) runs only on `v*` tag pushes. It first requires the tagged commit to be reachable from `main`, validates all package and project-lock versions, checks the public tree, and runs the locked engine and browser suites. Each native amd64/arm64 runner then builds its OCI archive once, including provenance and an SBOM, and loads that archive's runtime for the offline smoke test. A configuration-digest check binds the loaded runtime (including its filesystem layer identities) to the OCI archive. Runtime state is created in throwaway volumes and is never included in the archive.

Only the original tested archives and their digest reports are retained as workflow artifacts, for one day. A separate publishing job receives `packages: write` after all checks succeed. It revalidates the archive hashes, labels, runtime and attestation subjects, copies every manifest with `skopeo --preserve-digests`, and combines the unchanged amd64/arm64 runtime and attestation manifests into the release index. It does not rebuild the application or reinstall its dependencies. The final index is checked against the complete tested manifest set before its digest is recorded. Publishing uses the job's short-lived GitHub token; no personal registry token is needed. If retained artifacts have expired, rerun the complete workflow so both architectures are rebuilt and retested.

After the workflow succeeds, inspect the published manifest and digest, pull the exact image without authentication to confirm public availability, and create the GitHub release with the relevant changelog entry and immutable image reference. The workflow deliberately does not create a release announcement before the image has been verified. GitHub may initially create a GHCR package as private; check its package visibility for the first publication before documenting anonymous installation.

The tag validator accepts SemVer versions with an optional prerelease, without build metadata (`+...`, which is not a Docker tag character). Release metadata and tag-selection behavior have their own offline test:

```sh
node --test scripts/release-metadata.test.mjs scripts/release-oci.test.mjs
```

Official references: [Docker OCI exports](https://docs.docker.com/build/exporters/oci-docker/), [BuildKit attestations](https://docs.docker.com/build/ci/github-actions/attestations/), [digest-preserving Skopeo copy](https://github.com/podman-container-tools/skopeo/blob/main/docs/skopeo-copy.1.md), [manifest composition](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/), and [GitHub package publishing](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Upgrade and rollback

Record the current image digest and stop the engine before backing up its private volumes. Keep Codex authentication backups private. Start the desired pinned image with the same configured volumes, then check its logs and queue status before sending a synthetic owner task. A successful image build or offline smoke test does not establish that a Discord bot token or real Codex login is valid.

Do not run two engine instances against the same SQLite state at once. To roll back, stop the new instance and return to the previous pinned digest. If a future release introduces a state schema migration, follow that release's compatibility instructions and restore a compatible backup when required; do not assume every database change is reversible.
