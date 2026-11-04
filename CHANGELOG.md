# Changelog

## Unreleased

- Recover full blocked queues atomically without discarding work when recovery fails.
- Preserve service-user access to browser installations under a restrictive administrator umask.
- Check workspace permissions portably in the offline engine suite.

## 0.1.0 — Initial public core

- Owner-configured Discord identities and a separate private workspace initializer.
- Single-worker SQLite queue, exact per-thread Codex sessions and explicit interruption recovery.
- Scoped local Markdown memory commits and an optional Camoufox stdio MCP bridge.
- Synthetic templates, offline tests, English documentation and MIT license.
