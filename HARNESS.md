# LLM task harness

Gives an LLM a task plus held-out tests, runs the verify gates on what it
produces, feeds the failures back, and records every round. Use it to answer
questions like "how often does model X solve this kind of change, how many
rounds does it need, and where does it usually fail?".

Builds on `VERIFY.md` (the gates). Everything here is ours: no existing harness
for Obsidian plugins was found.

## How one attempt works

1. Make a fresh git worktree from your current commit (in your system temp dir).
2. Remove `harness/` from it (so the agent cannot read reference answers) and copy
   in the task's `overlay/` (held-out tests). Commit that as the starting point.
3. Run verify once: the **baseline** must fail, otherwise the task tests nothing new.
4. Loop up to `--max-iters` times: agent changes code -> `scripts/verify.mjs` ->
   if not `VERIFY OK`, send the failing gate details back.
5. Record each round, save the final diff, delete the worktree.

The agent may only change `src/`, `tests/` (not `tests/hidden/`) and `styles.css`.
Config files that could weaken the gates (`eslint.config.mts`, `tsconfig*.json`,
`vitest.config.ts`, `package.json`, `manifest.json`, `e2e/`, `scripts/` ...) are
passed to the `protected` gate, so changing them fails verification.

## Quick start

All commands run from the plugin root (the folder with `package.json`), with a
clean, committed tree (attempts start from `HEAD`).

```bash
npm ci
npm run harness:selftest                     # proves the harness itself works; no API key needed
```

Real runs, one per agent type:

```bash
# Anthropic API (the harness sends the files and applies the <file> blocks it gets back)
export ANTHROPIC_API_KEY=...
node harness/run.mjs --task unwrap-callout --agent api --model claude-sonnet-5-5 --attempts 5

# Any command-line coding agent, run inside the worktree with the prompt on stdin
node harness/run.mjs --task unwrap-callout --agent command \
  --cmd "claude -p --permission-mode acceptEdits" --attempts 3

# Re-score a saved response (also how a task's reference answer is checked)
node harness/run.mjs --task unwrap-callout --agent replay \
  --replay harness/tasks/unwrap-callout/reference.md
```

Add `--e2e` to include the real-Obsidian gate (about 25-50 s more per round;
see VERIFY.md for the headless/xvfb and pre-downloaded Obsidian notes).
For the command agent, check your agent's own `--help` for its non-interactive
flags; the example above is Claude Code's.

Compare runs (grouped by task, agent, model, `--label`, e2e):

```bash
npm run harness:report
```

## Output

`harness/results/` (git-ignored):

- `results.jsonl`: one line per round (`type: "iteration"`: gate statuses, first
  failing gate, files changed, blocked writes, tokens, timings) and one per
  attempt (`type: "attempt"`: solved, rounds, path such as `unit > PASS`).
- `<run-id>/summary.md`: the table printed at the end of a run.
- `<run-id>/a<k>/i<j>/`: `prompt.md`, `response.md`, `verify-report.json`,
  `verify-output.txt` for every round, plus `a<k>/final.diff`.

Useful numbers: **solved** (within max rounds), **first try** (solved in round 1),
**mean iterations when solved**, and **first failed gate** counts (where the
model usually trips: types, lint rules, logic, or real-app behavior).

## Writing a task

```
harness/tasks/<id>/
  task.md          what to build, precise enough to be testable (shown to the agent)
  overlay/         files copied into the worktree as held-out tests, e.g.
    tests/hidden/<id>.test.ts     fast unit-level acceptance (vitest + obsidian mock)
    e2e/specs/<id>.e2e.ts         real-Obsidian acceptance (runs with --e2e)
  reference.md     your own solution as <file path="..."> blocks
```

Check a new task before giving it to an LLM:

```bash
node harness/run.mjs --task <id> --agent replay --replay harness/tasks/<id>/reference.md --e2e
```

Expect: baseline fails, reference solves on the first try. If the baseline passes,
the tests check nothing new; if the reference fails, the task or tests are wrong.

Tips:

- Pin names the tests depend on (function names, command ids) in `task.md`.
  Testing behavior the task does not state measures guessing, not coding.
- Put behavior the user would see in the e2e spec; unit tests the agent can
  see are easy to overfit. `--hide-spec` withholds the held-out tests.
- Use 5+ attempts per setting; single runs are noisy.

## Limits

- `api` mode sends all of `src/` and `tests/` each round. Fine for small plugins;
  for big ones use `command` mode with an agent that reads files itself.
- `command` agents run with your user's permissions. The worktree has no
  `harness/` folder, but an agent that goes looking could still find the main
  repo (e.g. via `git worktree list`) and read `reference.md` there. For
  untrusted agents, keep reference answers outside the repo or run in a container.
- Only the gates decide "solved". Read a few `final.diff` files: passing code can
  still be poor code.
- The task in this repo is small; it demonstrates the loop rather than
  measuring anything about real plugin work.

## Harness self-test (this repo)

| Case | Expected | Result |
|---|---|---|
| reference answer | solves round 1 (baseline fails at typecheck-tests) | OK |
| recorded buggy answer, then fix | `unit > PASS` | OK |
| cheater (writes hidden tests, lint config, `../`) | 3 writes blocked per round, unsolved | OK |
| api agent against a local fake API | correct request, 3-message conversation, tokens summed | OK |
| command agent, honest edits | solved, no flags | OK |
| command agent edits `eslint.config.mts` | fails at `protected`, flagged | OK |
| reference with `--e2e` in Obsidian 1.14.4 | 3/3 e2e tests pass | OK |
