#!/usr/bin/env node
// Verification gate for (possibly LLM-written) Obsidian plugin code.
//
// Runs a fixed sequence of checks, writes verify-report.json, prints a short
// summary, and exits non-zero if any required gate fails. The report is meant
// to be pasted back to an LLM as feedback.
//
// Usage (run from the plugin root):
//   node scripts/verify.mjs                 # all gates except e2e
//   node scripts/verify.mjs --e2e           # also run real-Obsidian e2e tests
//   node scripts/verify.mjs --lenient       # lint warnings do not fail (default: they do)
//   node scripts/verify.mjs --keep-going    # run every gate even after a failure

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
// LLM output should meet the strict bar: warnings fail unless --lenient.
const STRICT = !args.has('--lenient');
const KEEP_GOING = args.has('--keep-going');
const RUN_E2E = args.has('--e2e') || process.env.VERIFY_E2E === '1';
const MAX_DETAIL_LINES = 40;
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

const results = [];

function trim(text) {
	const lines = String(text ?? '').trim().split('\n');
	if (lines.length <= MAX_DETAIL_LINES) return lines.join('\n');
	return lines.slice(0, MAX_DETAIL_LINES).join('\n') + `\n... (${lines.length - MAX_DETAIL_LINES} more lines)`;
}

function run(cmd, cmdArgs, opts = {}) {
	const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
	return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' };
}

function npx(bin, binArgs, opts) {
	return run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', bin, ...binArgs], opts);
}

// --- gates -----------------------------------------------------------------

// Paths the code author (human or LLM) must not change in the same change set,
// e.g. held-out acceptance specs. Override with VERIFY_PROTECT="a,b".
const PROTECTED = (process.env.VERIFY_PROTECT ?? 'e2e,wdio.conf.mts,scripts/verify.mjs')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

function gateProtected() {
	if (run('git', ['rev-parse', '--is-inside-work-tree']).code !== 0) {
		return { ok: true, skipped: 'not a git repo' };
	}
	const r = run('git', ['status', '--porcelain', '--', ...PROTECTED]);
	const changed = r.stdout.trim();
	return { ok: changed.length === 0, detail: changed ? `protected files changed:\n${changed}` : '' };
}

function gateManifest() {
	const problems = [];
	let m;
	try {
		m = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
	} catch (e) {
		return { ok: false, detail: `manifest.json missing or invalid JSON: ${e.message}` };
	}
	for (const key of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
		if (typeof m[key] !== 'string' || m[key].length === 0) problems.push(`missing field "${key}"`);
	}
	if (typeof m.id === 'string') {
		if (!/^[a-z0-9-]+$/.test(m.id)) problems.push('id must be lowercase letters, digits and hyphens');
		if (m.id.includes('obsidian')) problems.push('id must not contain "obsidian"');
		if (m.id.endsWith('plugin')) problems.push('id must not end with "plugin"');
	}
	if (typeof m.name === 'string' && /obsidian|plugin$/i.test(m.name)) {
		problems.push('name must not contain "Obsidian" or end with "Plugin"');
	}
	if (typeof m.version === 'string' && !/^\d+\.\d+\.\d+$/.test(m.version)) {
		problems.push('version must be x.y.z');
	}
	if (typeof m.isDesktopOnly !== 'boolean') problems.push('isDesktopOnly should be set explicitly');
	return { ok: problems.length === 0, detail: problems.join('\n') };
}

function gateTypecheck() {
	const r = npx('tsc', ['--noEmit', '--skipLibCheck']);
	return { ok: r.code === 0, detail: trim(r.out) };
}

function gateTypecheckTests() {
	if (!existsSync(path.join(ROOT, 'tsconfig.test.json'))) return { ok: true, skipped: 'no tsconfig.test.json' };
	const r = npx('tsc', ['-p', 'tsconfig.test.json']);
	return { ok: r.code === 0, detail: trim(r.out) };
}

function gateLint() {
	const r = npx('eslint', ['.', '--format', 'json']);
	let files;
	try {
		files = JSON.parse(r.stdout);
	} catch {
		return { ok: false, detail: trim(r.out) };
	}
	let errors = 0;
	let warnings = 0;
	const lines = [];
	for (const f of files) {
		for (const msg of f.messages) {
			if (msg.severity === 2) errors++;
			else warnings++;
			const rel = path.relative(ROOT, f.filePath);
			lines.push(`${msg.severity === 2 ? 'error' : 'warn '} ${rel}:${msg.line}:${msg.column} ${msg.ruleId ?? 'parse'}: ${msg.message}`);
		}
	}
	const ok = errors === 0 && (!STRICT || warnings === 0);
	return { ok, counts: { errors, warnings }, detail: trim(lines.join('\n')) };
}

function gateUnit() {
	const outFile = path.join(ROOT, '.vitest', 'verify-unit.json');
	const r = npx('vitest', ['run', '--reporter=json', `--outputFile=${outFile}`]);
	let report;
	try {
		report = JSON.parse(readFileSync(outFile, 'utf8'));
	} catch {
		return { ok: false, detail: trim(r.out) };
	}
	const failures = [];
	for (const file of report.testResults ?? []) {
		if (file.status === 'failed' && (file.assertionResults ?? []).length === 0) {
			failures.push(`${path.relative(ROOT, file.name)}: ${file.message}`);
		}
		for (const t of file.assertionResults ?? []) {
			if (t.status === 'failed') {
				failures.push(`${t.fullName}\n  ${(t.failureMessages ?? []).join('\n').split('\n').slice(0, 6).join('\n  ')}`);
			}
		}
	}
	const counts = { passed: report.numPassedTests, failed: report.numFailedTests, total: report.numTotalTests };
	const ok = r.code === 0 && report.success === true && counts.total > 0;
	return { ok, counts, detail: trim(failures.join('\n') || (counts.total === 0 ? 'no tests found' : '')) };
}

function gateBuild() {
	const r = run(process.execPath, ['esbuild.config.mjs', 'production']);
	return { ok: r.code === 0 && existsSync(path.join(ROOT, 'main.js')), detail: trim(r.out) };
}

function gateBundle() {
	const file = path.join(ROOT, 'main.js');
	if (!existsSync(file)) return { ok: false, detail: 'main.js not found' };
	const problems = [];
	const size = statSync(file).size;
	const src = readFileSync(file, 'utf8');
	if (size > MAX_BUNDLE_BYTES) problems.push(`main.js is ${size} bytes (limit ${MAX_BUNDLE_BYTES})`);
	if (!/require\(["']obsidian["']\)/.test(src)) problems.push('main.js does not require("obsidian"); the obsidian module must stay external');
	if (/\beval\s*\(/.test(src)) problems.push('main.js contains eval(');
	if (/\bnew Function\s*\(/.test(src)) problems.push('main.js contains new Function(');
	return { ok: problems.length === 0, counts: { bytes: size }, detail: problems.join('\n') };
}

// Load the real bundle in a sandbox with a permissive obsidian stub and call
// onload/onunload. Catches top-level crashes and onload exceptions that unit
// tests on src/ can miss (bad bundling, wrong default export, etc).
async function gateSmokeLoad() {
	const file = path.join(ROOT, 'main.js');
	if (!existsSync(file)) return { ok: false, detail: 'main.js not found' };
	const calls = [];
	const anything = () => new Proxy(function () {}, {
		get: (_t, prop) => (prop === 'then' ? undefined : anything()),
		apply: () => anything(),
		construct: () => anything(),
	});
	class StubPlugin {
		constructor(app, manifest) { this.app = app; this.manifest = manifest; }
		addCommand(c) { calls.push(`addCommand:${c.id}`); return c; }
		addSettingTab() { calls.push('addSettingTab'); }
		addRibbonIcon() { calls.push('addRibbonIcon'); return anything(); }
		addStatusBarItem() { return anything(); }
		registerEvent() {}
		registerDomEvent() {}
		registerInterval(id) { return id; }
		register() {}
		async loadData() { return null; }
		async saveData() {}
	}
	class StubBase { constructor() { return anything(); } }
	const obsidianStub = new Proxy({ Plugin: StubPlugin }, {
		get: (target, prop) => (prop in target ? target[prop] : StubBase),
	});
	const realRequire = createRequire(file);
	const mod = { exports: {} };
	const sandbox = {
		module: mod,
		exports: mod.exports,
		require: (id) => (id === 'obsidian' ? obsidianStub : realRequire(id)),
		console,
		setTimeout, clearTimeout, setInterval, clearInterval,
		window: {}, document: anything(), navigator: { userAgent: 'node' },
	};
	try {
		vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: 'main.js' });
		const PluginClass = mod.exports.default ?? mod.exports;
		if (typeof PluginClass !== 'function') return { ok: false, detail: 'main.js has no default export class' };
		const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
		const plugin = new PluginClass(anything(), manifest);
		await plugin.onload();
		if (typeof plugin.onunload === 'function') await plugin.onunload();
	} catch (e) {
		return { ok: false, detail: trim(e && e.stack ? e.stack : String(e)) };
	}
	return { ok: true, detail: calls.join('\n') };
}

function gateE2E() {
	if (!RUN_E2E) return { ok: true, skipped: 'pass --e2e to run' };
	if (!existsSync(path.join(ROOT, 'wdio.conf.mts'))) return { ok: false, detail: 'wdio.conf.mts not found' };
	// Headless Linux (CI, containers) has no display; wrap in xvfb-run if available.
	const headless = process.platform === 'linux' && !process.env.DISPLAY;
	const hasXvfb = headless && run('sh', ['-c', 'command -v xvfb-run']).code === 0;
	if (headless && !hasXvfb) return { ok: false, detail: 'no DISPLAY and xvfb-run not installed (apt install xvfb)' };
	const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
	const r = hasXvfb
		? run('xvfb-run', ['-a', npxBin, '--no-install', 'wdio', 'run', './wdio.conf.mts'])
		: npx('wdio', ['run', './wdio.conf.mts']);
	// The reporter prints one "N passing" / "N failing" line per spec file; sum them.
	const total = (re) => [...r.out.matchAll(re)].reduce((s, m) => s + Number(m[1]), 0);
	const counts = { passed: total(/(\d+) passing/g), failed: total(/(\d+) failing/g) };
	const interesting = r.out
		.split('\n')
		.filter((l) => !/^\s+at /.test(l) && !/CreatePlatformSocket/.test(l))
		.filter((l) => /\u2713|\u2716|passing|failing|Error|expect|Expected|Received|FAILED/i.test(l));
	return { ok: r.code === 0 && counts.passed > 0, counts, detail: trim(interesting.join('\n') || r.out) };
}

// --- runner ----------------------------------------------------------------

const GATES = [
	['protected', gateProtected],
	['manifest', gateManifest],
	['typecheck', gateTypecheck],
	['typecheck-tests', gateTypecheckTests],
	['lint', gateLint],
	['unit', gateUnit],
	['build', gateBuild],
	['bundle', gateBundle],
	['smoke-load', gateSmokeLoad],
	['e2e', gateE2E],
];

let stopped = false;
for (const [name, fn] of GATES) {
	if (stopped) {
		results.push({ gate: name, status: 'not-run' });
		continue;
	}
	const started = Date.now();
	const r = await fn();
	const status = r.skipped ? 'skipped' : r.ok ? 'pass' : 'fail';
	results.push({ gate: name, status, ms: Date.now() - started, counts: r.counts, reason: r.skipped, detail: r.detail || undefined });
	if (status === 'fail' && !KEEP_GOING) stopped = true;
}

const failed = results.filter((r) => r.status === 'fail');
const report = {
	ok: failed.length === 0,
	strict: STRICT,
	timestamp: new Date().toISOString(),
	gates: results,
};
writeFileSync(path.join(ROOT, 'verify-report.json'), JSON.stringify(report, null, 2) + '\n');

for (const r of results) {
	const extra = r.counts ? ' ' + JSON.stringify(r.counts) : r.reason ? ` (${r.reason})` : '';
	console.log(`${r.status.toUpperCase().padEnd(8)} ${r.gate}${extra}`);
}
for (const r of failed) {
	console.log(`\n--- ${r.gate} ---\n${r.detail ?? ''}`);
}
console.log(`\n${report.ok ? 'VERIFY OK' : 'VERIFY FAILED'} -> verify-report.json`);
process.exit(report.ok ? 0 : 1);
