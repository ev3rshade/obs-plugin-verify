# Verification workflow for LLM-written Obsidian plugin code

Goal: an LLM (or anyone) can change the plugin, and one command decides whether
the change is acceptable. The output is machine-readable so it can be fed back
to the LLM as the next prompt.

## What already exists (and is used here)

| Piece | Who makes it | Role here |
|---|---|---|
| `obsidian-sample-plugin` (incl. `AGENTS.md`) | Obsidian (official) | Starting template |
| `eslint-plugin-obsidianmd` | Obsidian (official) | Same rules the community-plugin review uses |
| `wdio-obsidian-service` | Community (jesse-r-s-hines) | Runs tests inside a real, sandboxed Obsidian |
| `vitest` + a hand-written `obsidian` mock | Common community pattern | Fast unit tests outside Obsidian |
| Obsidian CLI (`plugin:reload`, `dev:errors`, `eval`) | Obsidian (official) | Manual/agent loop against your own running app (not used in CI here) |

## What is ours (no ready-made version found)

- `scripts/verify.mjs`: the ordered gate runner and `verify-report.json`
- the `smoke-load` gate: executes the built `main.js` against a stub
- the `protected` gate: blocks changes to held-out specs and the verifier itself
- `scripts/selftest.mjs`: mutation self-test proving each gate fails when it should

## Gates (in order; stops at first failure unless `--keep-going`)

| Gate | Catches |
|---|---|
| protected | LLM editing acceptance specs (`e2e/`), `wdio.conf.mts` or the verifier |
| manifest | id/name/version rules the review bot enforces |
| typecheck | hallucinated APIs, wrong signatures (against real Obsidian types) |
| typecheck-tests | tests/mocks drifting from the real API shape |
| lint | Obsidian review rules; warnings fail by default (`--lenient` to relax) |
| unit | logic bugs (vitest, runs in Node with the mock) |
| build | bundling errors |
| bundle | size limit, `obsidian` must stay external, no `eval`/`new Function` |
| smoke-load | crashes at load or in `onload()` in the actual bundle |
| e2e | behavior in real Obsidian, using specs the LLM is not allowed to edit |

## Running it

All commands run from the plugin root (the folder containing `package.json`):

```bash
npm ci
npm run verify          # all gates except e2e (seconds)
npm run verify:e2e      # plus real Obsidian (downloads it once into .obsidian-cache/)
npm run selftest        # prove the gates catch injected mistakes
npm run selftest:e2e    # same, including the e2e-only mutation
```

Headless Linux needs `xvfb` (`sudo apt install xvfb`); the verifier wraps e2e in
`xvfb-run` automatically when there is no `DISPLAY`. macOS/Windows need nothing.

If Obsidian cannot be auto-downloaded (proxy, offline CI), point at a local copy:

```bash
OBSIDIAN_VERSION=1.14.4 OBSIDIAN_INSTALLER_VERSION=1.14.4 \
OBSIDIAN_BINARY=/path/to/obsidian-1.14.4/obsidian \
OBSIDIAN_ASAR=/path/to/obsidian-1.14.4/resources/obsidian.asar \
npm run verify:e2e
```

## Using it with an LLM

1. Commit the acceptance specs (`e2e/specs/*.e2e.ts`) yourself before asking the LLM for code.
2. Give the LLM the task plus: "run `npm run verify:e2e`; you are done only when it prints VERIFY OK; do not edit e2e/, wdio.conf.mts or scripts/verify.mjs".
3. On failure, feed back `verify-report.json` (each failing gate has a trimmed `detail`).
4. Review the diff anyway. The gates catch classes of mistakes, not all of them.

## Self-test result (this repo, Obsidian 1.14.4)

| Injected mistake | Caught by |
|---|---|
| hallucinated `editor.replaceSelectionText` | typecheck |
| plugin name repeated in command name | lint |
| `fetch` instead of `requestUrl` | lint |
| blank lines silently dropped | unit |
| manifest id `obsidian-callout-plugin` | manifest |
| `onload` throws | smoke-load |
| e2e spec tampered | protected |
| behavior changed *and* unit tests edited to match | e2e (only) |

The last row is the key lesson: unit tests the LLM can edit are not an
independent check. Keep at least one layer of tests it cannot touch.

## Notes and known limits

- `obsidianmd/settings-tab/prefer-setting-definitions` is off in
  `eslint.config.mts`: the declarative settings API needs Obsidian 1.13+ and
  `minAppVersion` is 1.0.0. Revisit if that changes.
- `package.json` had `"obsidian": "latest"` but the lockfile froze types at
  1.12.3; it is now pinned to 1.14.4. Bump deliberately.
- `wdio-obsidian-service` 3.x requires WebdriverIO 9 (not 10).
- The sample's pinned `esbuild 0.25.5` conflicts with current vitest; bumped to 0.27.
- Mobile is not covered (the service supports emulation and Android; not set up here).

See HARNESS.md for running LLMs against tasks with these gates and recording results.
