# Obsidian plugin LLM tools

Tooling for checking LLM-written Obsidian plugin code and measuring how well
models handle plugin changes.

- [VERIFY.md](VERIFY.md): `scripts/verify.mjs`, an ordered set of gates
  (manifest, typecheck, lint, unit, build, bundle, smoke-load, e2e) that decides
  whether a change is acceptable and writes a report to feed back to the LLM.
- [HARNESS.md](HARNESS.md): `harness/`, which gives an LLM a task plus held-out
  tests, loops it against the gates, and records every round.

## Status

This repo holds the tooling only. The demo plugin it was built against
(`callout-wrapper`: `src/`, `manifest.json`, `package.json`,
`package-lock.json`) is not included, so nothing runs as-is. Most of the demo
source can be recovered from `harness/tasks/unwrap-callout/reference.md`.

To use the tooling, copy `scripts/`, `harness/` and the config files into a
plugin repo, then replace the callout-specific tests, e2e spec, selftest
mutations and harness task with ones for that plugin.
