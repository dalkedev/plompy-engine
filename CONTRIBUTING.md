# Contributing

Small, focused changes with an observable result are welcome. Explain the problem and provide
reproduction steps. Keep code, documentation, comments and user-facing engine messages in English.

```sh
npm --prefix apps/discord-agent ci --ignore-scripts
npm test
```

For browser changes, run the locked offline Python tests documented in its README. Add a
regression test for authorization, recovery or process-protocol changes. Tests must use synthetic
IDs, temporary state and fake model subprocesses; do not log into accounts or publish content.

Never include your private agent workspace, browser profile, credentials, raw model events or
conversation transcripts in a pull request. Preserve dependency locks and explain protocol or
runtime compatibility changes. Local tests do not establish live service compatibility.

By contributing, you agree that your contribution is available under the repository's MIT license.

## GitHub Actions template

[examples/github-actions/checks.yml](examples/github-actions/checks.yml) is a ready-to-copy
workflow for the Node and Python offline suites. It is **inactive** until a maintainer copies
it to `.github/workflows/checks.yml` using a GitHub connection allowed to create workflows.
The initial publishing connection lacks the `workflow` OAuth scope, so no CI run or passing
GitHub status is claimed. Local verification is documented separately.
