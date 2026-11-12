# Maintaining the public release history

`CHANGELOG.md` is the source of release changes. `catalog.json` records which
versions actually have a published GitHub release, their publication dates,
latest-stable designation and downloadable assets. A changelog entry alone does
not make a release public.

After publishing a release and its final assets, refresh the catalog from the
public GitHub API:

```sh
node docs/releases/sync.mjs
node --test docs/releases/sync.test.mjs
```

Review and commit the catalog. The sync reads public metadata only; it does not
publish, edit releases, download artifacts or need account credentials. Drafts
and unpublished entries are excluded. Prereleases are retained and labelled.

The website builder reads `docs/local/navigation.json`, `docs/local/releases.md`,
`CHANGELOG.md` and this catalog when `releaseHistory` is enabled. It generates the
release index and individual version pages at `/docs/releases/`. Notes are not
copied into separate hand-maintained pages. Builds fail when a published version
has no matching changelog entry. Source-relative links point to the corresponding
Git tag so historical pages do not silently become current instructions.

From a sibling `plompy-site` checkout, rebuild and verify:

```sh
npm run build -- --docs-source ../plompy-engine/docs/local
npm run check
npm run test:docs
```

Normal site builds use the committed generated pages without fetching GitHub.
The generated manifest records hashes for both release sources. Development-only
changelog entries stay out of the public history until a release is published and
the catalog is refreshed.
