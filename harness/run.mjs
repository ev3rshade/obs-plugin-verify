#!/usr/bin/env node
// LLM task harness for this Obsidian plugin repo.
//
// For each attempt: make a fresh git worktree from HEAD, install the task's
// held-out tests ("overlay"), then loop: ask the agent for code -> run
// scripts/verify.mjs -> feed the failures back -> repeat until VERIFY OK or
// --max-iters. Every iteration is recorded.
//
// Run from the plugin root (the folder with package.json):
//   node harness/run.mjs --task unwrap-callout --agent api --attempts 3
//   node harness/run.mjs --task unwrap-callout --agent command --cmd "claude -p --permission-mode acceptEdits"
//   node harness/run.mjs --task unwrap-callout --agent replay --replay harness/tasks/unwrap-callout/reference.md
//
// Options:
//   --task <id|dir>        task folder (harness/tasks/<id>) with task.md and overlay/
//   --agent api|command|replay
//   --attempts <n>         independent attempts (default 1)
//   --max-iters <n>        feedback rounds per attempt (default 3)
//   --e2e                  include the real-Obsidian e2e gate
//   --model <name>         api agent model (default claude-sonnet-5-5)
//   --max-tokens <n>       api agent max output tokens (default 16000)
//   --cmd "<command>"      command agent: shell command run in the worktree,
//                          prompt on stdin; {prompt_file} and {workdir} are substituted
//   --agent-timeout <s>    command agent timeout in seconds (default 900)
//   --replay <file|dir>    replay agent: one response file, or a dir of iter1.md, iter2.md, ...
//   --hide-spec            do not show the held-out tests to the agent
//   --label <text>         free text stored with the results (e.g. prompt version)
//   --keep                 keep worktrees for inspection
//   --quiet                less console output
//
// Environment:
//   ANTHROPIC_API_KEY      for --agent api
//   HARNESS_API_URL        override API base URL (default https://api.anthropic.com)
//
// Output: harness/results/<run-id>/ (prompts, responses, reports, diffs,
// summary.md) and one line per iteration and per attempt appended to
// harness/results/results.jsonl.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const RESULTS_DIR = path.join(ROOT, 'harness', 'results');

// What the agent may write (api/replay) or change (command).
const ALLOWED = ['src/', 'tests/', 'styles.css'];
const DENIED = ['tests/hidden/'];
// Passed to verify.mjs as protected paths: anything that could weaken the gates.
const PROTECT = [
	'e2e', 'wdio.conf.mts', 'scripts', 'tests/hidden',
	'eslint.config.mts', 'tsconfig.json', 'tsconfig.test.json', 'vitest.config.ts',
	'esbuild.config.mjs', 'package.json', 'package-lock.json', 'manifest.json',
];
const GIT_ID = ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost'];

// --- small helpers ------------------------------------------------------------

function die(msg) {
	console.error(`harness: ${msg}`);
	process.exit(2);
}

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
	return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

function git(args, cwd) {
	const r = run('git', args, { cwd });
	if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
	return r.stdout.trim();
}

function walk(dir, base = dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, base));
		else out.push(path.relative(base, full).split(path.sep).join('/'));
	}
	return out.sort();
}

function normRel(p) {
	const clean = path.posix.normalize(String(p).replace(/\\/g, '/'));
	if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean === '..' || clean.startsWith('../')) return null;
	return clean;
}

function isAllowed(rel) {
	if (!rel) return false;
	const ok = ALLOWED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));
	return ok && !DENIED.some((d) => rel.startsWith(d));
}

function writeFile(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

function stamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// --- options --------------------------------------------------------------------

function parseArgs(argv) {
	const o = {
		agent: 'api', attempts: 1, maxIters: 3, e2e: false, model: 'claude-sonnet-5-5',
		maxTokens: 16000, agentTimeout: 900, hideSpec: false, keep: false, quiet: false, label: '',
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) die(`missing value for ${a}`);
			return v;
		};
		switch (a) {
			case '--task': o.task = next(); break;
			case '--agent': o.agent = next(); break;
			case '--attempts': o.attempts = Number(next()); break;
			case '--max-iters': o.maxIters = Number(next()); break;
			case '--e2e': o.e2e = true; break;
			case '--model': o.model = next(); break;
			case '--max-tokens': o.maxTokens = Number(next()); break;
			case '--cmd': o.cmd = next(); break;
			case '--agent-timeout': o.agentTimeout = Number(next()); break;
			case '--replay': o.replay = next(); break;
			case '--hide-spec': o.hideSpec = true; break;
			case '--label': o.label = next(); break;
			case '--keep': o.keep = true; break;
			case '--quiet': o.quiet = true; break;
			default: die(`unknown option ${a}`);
		}
	}
	if (!o.task) die('--task is required');
	if (!['api', 'command', 'replay'].includes(o.agent)) die('--agent must be api, command or replay');
	if (o.agent === 'command' && !o.cmd) die('--agent command needs --cmd');
	if (o.agent === 'replay' && !o.replay) die('--agent replay needs --replay');
	if (o.agent === 'api' && !process.env.ANTHROPIC_API_KEY) die('ANTHROPIC_API_KEY is not set');
	if (!(o.attempts >= 1) || !(o.maxIters >= 1)) die('--attempts and --max-iters must be >= 1');
	return o;
}

function loadTask(spec) {
	const dir = fs.existsSync(path.join(ROOT, 'harness', 'tasks', spec))
		? path.join(ROOT, 'harness', 'tasks', spec)
		: path.resolve(ROOT, spec);
	const taskFile = path.join(dir, 'task.md');
	if (!fs.existsSync(taskFile)) die(`no task.md in ${dir}`);
	const overlayDir = path.join(dir, 'overlay');
	const overlay = walk(overlayDir).map((rel) => ({ rel, text: fs.readFileSync(path.join(overlayDir, rel), 'utf8') }));
	return { id: path.basename(dir), dir, text: fs.readFileSync(taskFile, 'utf8'), overlay };
}

// --- prompts --------------------------------------------------------------------

const RULES = `You are changing an Obsidian community plugin written in TypeScript.

Rules:
- Only change files under src/ and tests/ (but not tests/hidden/), and styles.css.
- Do not change build, lint, test or TypeScript config, package.json, manifest.json, e2e/ or scripts/.
- Your work is checked by: tsc (strict), eslint with eslint-plugin-obsidianmd (warnings fail),
  vitest unit tests (including held-out tests in tests/hidden/), an esbuild bundle check,
  a load smoke test of main.js, and possibly end-to-end tests in a real Obsidian app.
- Common Obsidian review rules: use requestUrl instead of fetch; do not repeat the plugin name
  in command names; sentence case for UI text; no innerHTML; no console.log; register
  listeners with registerEvent / registerDomEvent.
- Unit tests run against a mock of the 'obsidian' module in tests/__mocks__/obsidian.ts;
  extend the mock if your tested code needs more of the API.`;

const FILE_FORMAT = `Reply with every file you create or change, complete (never a diff), like this:
<file path="src/example.ts">
...entire file contents...
</file>
To delete a file: <delete path="src/old.ts"/>
Text outside these tags is ignored.`;

function specSection(task, hideSpec) {
	if (task.overlay.length === 0) return '';
	if (hideSpec) return '\n## Acceptance tests\n\nHeld-out acceptance tests exist; they are not shown.\n';
	return '\n## Acceptance tests (held out, read only)\n\n' + task.overlay
		.map((f) => `<file path="${f.rel}">\n${f.text}</file>`)
		.join('\n\n') + '\n';
}

function contextSection(wt) {
	const files = ['manifest.json', 'styles.css', ...walk(path.join(wt, 'src')).map((f) => `src/${f}`),
		...walk(path.join(wt, 'tests')).map((f) => `tests/${f}`).filter((f) => !f.startsWith('tests/hidden/'))];
	const parts = [];
	for (const rel of files) {
		const full = path.join(wt, rel);
		if (!fs.existsSync(full)) continue;
		parts.push(`<file path="${rel}">\n${fs.readFileSync(full, 'utf8')}</file>`);
	}
	return '\n## Current files\n\n' + parts.join('\n\n') + '\n';
}

function firstPrompt(o, task, wt) {
	const head = `${task.text.trim()}\n${specSection(task, o.hideSpec)}`;
	if (o.agent === 'command') {
		return `${RULES}\n\n${head}\nEdit the files in this directory directly. You can run \`npm run verify\` to check your work.\n`;
	}
	return `${head}${contextSection(wt)}\n${FILE_FORMAT}\n`;
}

function feedbackPrompt(o, task, report, violations, notes) {
	const lines = ['Verification failed. Gate results:'];
	for (const g of report.gates) lines.push(`${g.status.toUpperCase()} ${g.gate}`);
	for (const g of report.gates.filter((x) => x.status === 'fail')) {
		lines.push(`\n--- ${g.gate} ---\n${g.detail ?? ''}`);
	}
	if (violations.length) lines.push('\nNot allowed (ignored or flagged):\n' + violations.map((v) => `- ${v}`).join('\n'));
	for (const n of notes) lines.push(`\n${n}`);
	const fb = lines.join('\n');
	if (o.agent === 'command') {
		// Command agents are stateless between iterations: resend the task.
		return `${firstPrompt(o, task, null)}\n## Feedback from the previous attempt\n\n${fb}\n\nFix the problems.\n`;
	}
	return `${fb}\n\nFix the problems. ${FILE_FORMAT}\n`;
}

// --- agents ---------------------------------------------------------------------

function applyFiles(wt, text) {
	const applied = [];
	const violations = [];
	for (const m of text.matchAll(/<file path="([^"]+)">\r?\n?([\s\S]*?)<\/file>/g)) {
		const rel = normRel(m[1]);
		if (!isAllowed(rel)) {
			violations.push(`write blocked: ${m[1]}`);
			continue;
		}
		const body = m[2].endsWith('\n') ? m[2] : m[2] + '\n';
		writeFile(path.join(wt, rel), body);
		applied.push(rel);
	}
	for (const m of text.matchAll(/<delete path="([^"]+)"\s*\/>/g)) {
		const rel = normRel(m[1]);
		if (!isAllowed(rel)) {
			violations.push(`delete blocked: ${m[1]}`);
			continue;
		}
		fs.rmSync(path.join(wt, rel), { force: true });
		applied.push(`deleted ${rel}`);
	}
	return { applied, violations };
}

async function callAnthropic(o, system, messages) {
	const url = `${process.env.HARNESS_API_URL ?? 'https://api.anthropic.com'}/v1/messages`;
	let lastErr;
	for (let tryNo = 0; tryNo < 4; tryNo++) {
		if (tryNo > 0) await new Promise((r) => setTimeout(r, 2000 * 2 ** tryNo));
		let res;
		try {
			res = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': process.env.ANTHROPIC_API_KEY,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify({ model: o.model, max_tokens: o.maxTokens, system, messages }),
			});
		} catch (e) {
			lastErr = e;
			continue;
		}
		if (res.status === 429 || res.status >= 500) {
			lastErr = new Error(`API ${res.status}: ${(await res.text()).slice(0, 500)}`);
			continue;
		}
		if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 2000)}`);
		const data = await res.json();
		const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
		return { text, usage: data.usage ?? {}, stopReason: data.stop_reason };
	}
	throw lastErr;
}

function makeAgent(o) {
	if (o.agent === 'api') {
		const messages = [];
		return {
			async step(wt, prompt) {
				messages.push({ role: 'user', content: prompt });
				const r = await callAnthropic(o, RULES, messages);
				messages.push({ role: 'assistant', content: r.text || '(empty)' });
				return { response: r.text, usage: r.usage, stopReason: r.stopReason, ...applyFiles(wt, r.text) };
			},
		};
	}
	if (o.agent === 'replay') {
		const src = path.resolve(ROOT, o.replay);
		const isDir = fs.statSync(src).isDirectory();
		let n = 0;
		return {
			async step(wt) {
				n++;
				let file = src;
				if (isDir) {
					const all = walk(src).filter((f) => /^iter\d+\.md$/.test(f)).sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));
					if (all.length === 0) throw new Error(`no iterN.md files in ${src}`);
					file = path.join(src, all[Math.min(n, all.length) - 1]);
				}
				const text = fs.readFileSync(file, 'utf8');
				return { response: text, usage: {}, ...applyFiles(wt, text) };
			},
		};
	}
	// command
	const flagged = new Set();
	return {
		async step(wt, prompt, iterDir) {
			const promptFile = path.join(iterDir, 'prompt.md');
			const cmd = o.cmd.replaceAll('{prompt_file}', JSON.stringify(promptFile)).replaceAll('{workdir}', JSON.stringify(wt));
			const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
			const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
			const r = run(shell, shellArgs, { cwd: wt, input: prompt, timeout: o.agentTimeout * 1000 });
			const response = `exit=${r.code}${r.error ? ` error=${r.error.message}` : ''}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
			// The agent edits files itself; flag anything outside the allowlist.
			const violations = [];
			const applied = [];
			// -z: NUL-separated, unquoted paths; a rename entry is followed by its old path.
			const entries = run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: wt }).stdout.split('\0');
			const paths = [];
			for (let i = 0; i < entries.length; i++) {
				const e = entries[i];
				if (e.length < 4) continue;
				paths.push(e.slice(3));
				if (e[0] === 'R' || e[0] === 'C') paths.push(entries[++i]);
			}
			for (const rel of paths) {
				if (isAllowed(rel)) applied.push(rel);
				else if (!flagged.has(rel)) {
					flagged.add(rel);
					violations.push(`changed outside allowlist: ${rel}`);
				}
			}
			return { response, usage: {}, applied, violations };
		},
	};
}

// --- one attempt ------------------------------------------------------------------

function setupWorktree(runId, k, base, task) {
	const wt = path.join(os.tmpdir(), 'obsidian-harness', `${runId}-a${k}`);
	fs.rmSync(wt, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(wt), { recursive: true });
	git(['worktree', 'add', '--detach', wt, base], ROOT);
	fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(wt, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
	// The agent must not see the harness, other tasks or reference answers.
	fs.rmSync(path.join(wt, 'harness'), { recursive: true, force: true });
	for (const f of task.overlay) writeFile(path.join(wt, f.rel), f.text);
	git(['add', '-A'], wt);
	git([...GIT_ID, 'commit', '-q', '--allow-empty', '-m', `harness: set up task ${task.id}`], wt);
	return { wt, setupCommit: git(['rev-parse', 'HEAD'], wt) };
}

function runVerify(o, wt) {
	const reportFile = path.join(wt, 'verify-report.json');
	fs.rmSync(reportFile, { force: true });
	const started = Date.now();
	const r = run(process.execPath, ['scripts/verify.mjs', ...(o.e2e ? ['--e2e'] : [])], {
		cwd: wt,
		env: { ...process.env, VERIFY_PROTECT: PROTECT.join(','), OBSIDIAN_CACHE_DIR: path.join(ROOT, '.obsidian-cache') },
	});
	let report;
	try {
		report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
	} catch {
		report = { ok: false, gates: [{ gate: 'verify-crashed', status: 'fail', detail: (r.stdout + r.stderr).slice(-4000) }] };
	}
	return { report, stdout: r.stdout + r.stderr, ms: Date.now() - started };
}

function diffStats(wt, setupCommit) {
	git(['add', '-A'], wt);
	let added = 0;
	let removed = 0;
	const files = [];
	for (const line of git(['diff', '--cached', '--numstat', setupCommit], wt).split('\n').filter(Boolean)) {
		const [a, r, f] = line.split('\t');
		added += Number(a) || 0;
		removed += Number(r) || 0;
		files.push(f);
	}
	return { files, added, removed };
}

const firstFail = (report) => report.gates.find((g) => g.status === 'fail')?.gate ?? null;

async function runAttempt(o, task, runId, runDir, base, k, log) {
	const attemptDir = path.join(runDir, `a${k}`);
	const { wt, setupCommit } = setupWorktree(runId, k, base, task);
	const rows = [];
	const common = { run_id: runId, task: task.id, agent: o.agent, model: o.agent === 'api' ? o.model : o.agent === 'command' ? o.cmd : path.relative(ROOT, path.resolve(ROOT, o.replay)), label: o.label, e2e: o.e2e, attempt: k };
	let solved = false;
	try {
		// Baseline: the task should NOT already pass, or the spec is too weak.
		const baseline = runVerify(o, wt);
		const baselineFail = firstFail(baseline.report);
		if (baseline.report.ok) log(`  WARNING: baseline already passes; the held-out tests do not test anything new`);

		const agent = makeAgent(o);
		let prompt = firstPrompt(o, task, wt);
		for (let iter = 1; iter <= o.maxIters; iter++) {
			const iterDir = path.join(attemptDir, `i${iter}`);
			writeFile(path.join(iterDir, 'prompt.md'), prompt);
			const t0 = Date.now();
			let step;
			try {
				step = await agent.step(wt, prompt, iterDir);
			} catch (e) {
				step = { response: `AGENT ERROR: ${e.message}`, usage: {}, applied: [], violations: [], agentError: e.message };
			}
			const agentMs = Date.now() - t0;
			writeFile(path.join(iterDir, 'response.md'), step.response ?? '');
			const notes = [];
			if (step.stopReason === 'max_tokens') notes.push('Your previous reply was cut off at the output limit. Return fewer or smaller files.');
			if (o.agent !== 'command' && step.applied.length === 0 && !step.agentError) notes.push('Your previous reply contained no <file> blocks, so nothing changed.');

			const v = runVerify(o, wt);
			writeFile(path.join(iterDir, 'verify-report.json'), JSON.stringify(v.report, null, 2) + '\n');
			writeFile(path.join(iterDir, 'verify-output.txt'), v.stdout);
			const ds = diffStats(wt, setupCommit);
			const row = {
				type: 'iteration', ...common, iter,
				ok: v.report.ok === true,
				first_failed_gate: firstFail(v.report),
				gates: Object.fromEntries(v.report.gates.map((g) => [g.gate, g.status])),
				applied: step.applied, violations: step.violations, agent_error: step.agentError ?? null,
				stop_reason: step.stopReason ?? null,
				input_tokens: step.usage.input_tokens ?? null, output_tokens: step.usage.output_tokens ?? null,
				agent_ms: agentMs, verify_ms: v.ms,
				files_changed: ds.files.length, lines_added: ds.added, lines_removed: ds.removed,
				baseline_failed_gate: iter === 1 ? baselineFail : undefined,
			};
			rows.push(row);
			log(`  a${k} i${iter}: ${row.ok ? 'VERIFY OK' : `fail at ${row.first_failed_gate}`}${row.violations.length ? ` (${row.violations.length} violation(s))` : ''}`);
			if (row.ok) {
				solved = true;
				break;
			}
			if (step.agentError && o.agent === 'api') break; // API down or misconfigured; stop this attempt
			prompt = feedbackPrompt(o, task, v.report, step.violations, notes);
		}
		writeFile(path.join(attemptDir, 'final.diff'), run('git', ['diff', '--cached', setupCommit], { cwd: wt }).stdout);
	} finally {
		if (o.keep) log(`  worktree kept: ${wt}`);
		else {
			// Unlink the node_modules link first so nothing can follow it.
			fs.rmSync(path.join(wt, 'node_modules'), { force: true });
			run('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT });
			fs.rmSync(wt, { recursive: true, force: true });
		}
	}
	const sum = (key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0);
	const attemptRow = {
		type: 'attempt', ...common, solved,
		iterations: rows.length,
		solved_at_iter: solved ? rows.length : null,
		path: rows.map((r) => (r.ok ? 'PASS' : r.first_failed_gate)).join(' > '),
		baseline_failed_gate: rows[0]?.baseline_failed_gate ?? null,
		violations: rows.reduce((s, r) => s + r.violations.length, 0),
		input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
		agent_ms: sum('agent_ms'), verify_ms: sum('verify_ms'),
	};
	return { rows, attemptRow };
}

// --- summary ----------------------------------------------------------------------

function summarize(o, task, runId, attempts, iterations) {
	const n = attempts.length;
	const solved = attempts.filter((a) => a.solved);
	const firstTry = attempts.filter((a) => a.solved_at_iter === 1);
	const meanIters = solved.length ? solved.reduce((s, a) => s + a.iterations, 0) / solved.length : null;
	const gateFails = {};
	for (const r of iterations) if (r.first_failed_gate) gateFails[r.first_failed_gate] = (gateFails[r.first_failed_gate] ?? 0) + 1;
	const summary = {
		run_id: runId, task: task.id, agent: o.agent, model: attempts[0]?.model, label: o.label, e2e: o.e2e,
		max_iters: o.maxIters, attempts: n,
		solved: solved.length, solved_first_try: firstTry.length,
		solve_rate: n ? solved.length / n : 0, first_try_rate: n ? firstTry.length / n : 0,
		mean_iters_when_solved: meanIters,
		first_failed_gate_counts: gateFails,
		violations: attempts.reduce((s, a) => s + a.violations, 0),
		input_tokens: attempts.reduce((s, a) => s + a.input_tokens, 0),
		output_tokens: attempts.reduce((s, a) => s + a.output_tokens, 0),
	};
	const md = [
		`# ${task.id} - ${runId}`,
		'',
		`agent: ${o.agent} | model/cmd: ${summary.model} | e2e: ${o.e2e} | max iters: ${o.maxIters}${o.label ? ` | label: ${o.label}` : ''}`,
		'',
		`- solved: ${solved.length}/${n} (first try: ${firstTry.length}/${n})`,
		`- mean iterations when solved: ${meanIters === null ? '-' : meanIters.toFixed(2)}`,
		`- iterations failing at each gate: ${Object.entries(gateFails).map(([g, c]) => `${g} ${c}`).join(', ') || 'none'}`,
		`- blocked or flagged changes: ${summary.violations}`,
		`- tokens in/out: ${summary.input_tokens}/${summary.output_tokens}`,
		'',
		'| attempt | solved | iterations | path | violations | agent s | verify s |',
		'|---|---|---|---|---|---|---|',
		...attempts.map((a) => `| ${a.attempt} | ${a.solved ? 'yes' : 'no'} | ${a.iterations} | ${a.path} | ${a.violations} | ${(a.agent_ms / 1000).toFixed(1)} | ${(a.verify_ms / 1000).toFixed(1)} |`),
		'',
	].join('\n');
	return { summary, md };
}

// --- main ---------------------------------------------------------------------------

async function main() {
	const o = parseArgs(process.argv.slice(2));
	const log = o.quiet ? () => undefined : (m) => console.log(m);
	if (!fs.existsSync(path.join(ROOT, 'scripts', 'verify.mjs'))) die('run from the plugin root (scripts/verify.mjs not found)');
	if (!fs.existsSync(path.join(ROOT, 'node_modules'))) die('node_modules missing; run npm ci first');
	const task = loadTask(o.task);
	const base = git(['rev-parse', 'HEAD'], ROOT);
	const dirty = git(['status', '--porcelain', '--untracked-files=no'], ROOT);
	if (dirty) log(`WARNING: uncommitted changes are NOT included (attempts start from ${base.slice(0, 7)}):\n${dirty}`);

	const runId = `${stamp()}-${task.id}-${o.agent}`;
	const runDir = path.join(RESULTS_DIR, runId);
	fs.mkdirSync(runDir, { recursive: true });
	log(`run ${runId}: ${o.attempts} attempt(s), up to ${o.maxIters} iteration(s) each${o.e2e ? ', with e2e' : ''}`);

	const attempts = [];
	const iterations = [];
	for (let k = 1; k <= o.attempts; k++) {
		const { rows, attemptRow } = await runAttempt(o, task, runId, runDir, base, k, log);
		iterations.push(...rows);
		attempts.push(attemptRow);
		fs.appendFileSync(path.join(RESULTS_DIR, 'results.jsonl'), [...rows, attemptRow].map((r) => JSON.stringify(r)).join('\n') + '\n');
	}
	const { summary, md } = summarize(o, task, runId, attempts, iterations);
	writeFile(path.join(runDir, 'summary.json'), JSON.stringify({ summary, attempts }, null, 2) + '\n');
	writeFile(path.join(runDir, 'summary.md'), md);
	console.log(`\n${md}\nresults: ${path.relative(ROOT, runDir)}`);
	process.exit(summary.solved > 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
