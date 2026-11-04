# Contributing

Small, focused changes with an observable result are welcome. Explain the problem, include
reproduction steps, and describe the resulting behavior. Keep code, documentation, comments,
and user-facing engine messages in English.

## Work locally

Use Node.js **24.x** and the committed dependency locks:

```sh
npm --prefix apps/discord-agent ci --ignore-scripts
npm test
```

The Node suite builds the engine and checks it offline. For browser changes, run the locked
Python suite in the [browser guide](packages/browser/README.md#manual-login-and-verification).
The repository's [CI workflow](.github/workflows/checks.yml) runs both offline suites.

Add a regression test for authorization, recovery, or process-protocol changes. Use synthetic
IDs, temporary state, and fake model subprocesses. Do not log into accounts, send real messages,
or publish content as a test. Local and CI checks do not establish live service compatibility.

## Keep a pull request reviewable

- Describe the concrete problem and the behavior after your change.
- Include the checks you ran and any limits of that validation.
- Preserve dependency locks and explain runtime or protocol compatibility changes.
- Update the relevant [documentation](docs/index.md) when setup or behavior changes.
- Follow the [brand guide](docs/brand.md) when using the project name or visual assets.

Never include private workspaces, credentials, deployment IDs, browser profiles, raw model
events, conversation transcripts, or real account data in a pull request. Use the
[security guidance](SECURITY.md) for sensitive reports.

By contributing, you agree that your contribution is available under the repository's
[MIT license](LICENSE).
