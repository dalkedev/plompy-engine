# Discord engine

See the root [README](../../README.md), [configuration](../../docs/configuration.md) and
[architecture](../../docs/architecture.md). Build and test using Node 26.13.0 or newer 26.x LTS:

```sh
npm ci --ignore-scripts
npm test
```

Run one process only, with a singleton lock, a private workspace and a configured owner-owned forum.
