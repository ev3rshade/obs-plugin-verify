#!/usr/bin/env node
// Self-test for the verification gates ("test the tests").
// Applies one typical LLM mistake at a time, runs verify.mjs --keep-going,
// and checks that the expected gate fails. Files are always restored.
//
// Usage (run from the plugin root, with a clean git tree):
//   node scripts/selftest.mjs          # skips mutations that need e2e
//   node scripts/selftest.mjs --e2e    # includes real-Obsidian e2e mutations

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const WITH_E2E = process.argv.includes('--e2e');

// Each mutation: edits = [file, find, replace]; expect = gate that must fail.
const MUTATIONS = [
	{
		name: 'hallucinated API method',
		edits: [['src/main.ts', 'editor.replaceSelection(', 'editor.replaceSelectionText(']],
		expect: 'typecheck',
	},
	{
		name: 'plugin name repeated in command name',
		edits: [['src/main.ts', "name: 'Wrap selection in callout'", "name: 'Callout Wrapper: wrap selection'"]],
		expect: 'lint',
	},
	{
		name: 'fetch instead of requestUrl',
		edits: [['src/main.ts', '\t\tawait this.loadSettings();', "\t\tawait this.loadSettings();\n\t\tvoid fetch('https://example.com');"]],
		expect: 'lint',
	},
	{
		name: 'logic bug: blank lines silently dropped',
		edits: [['src/callout.ts', "\t\t.split('\\n')\n", "\t\t.split('\\n')\n\t\t.filter((l) => l.length > 0)\n"]],
		expect: 'unit',
	},
	{
		name: 'manifest id breaks naming rules',
		edits: [['manifest.json', '"id": "callout-wrapper"', '"id": "obsidian-callout-plugin"']],
		expect: 'manifest',
	},
	{
		name: 'onload throws at runtime',
		edits: [['src/main.ts', '\t\tawait this.loadSettings();', "\t\tawait this.loadSettings();\n\t\tif (this.settings) throw new Error('boom');"]],
		expect: 'smoke-load',
	},
	{
		name: 'tampered held-out spec',
		edits: [['e2e/specs/wrap.e2e.ts', "toBe(true)", "toBe(false)"]],
		expect: 'protected',
	},
	{
		name: 'behavior change with unit tests edited to match',
		edits: [
			['src/callout.ts', '`> [!${type}]`', '`> [!${type.toUpperCase()}]`'],
			['src/callout.ts', '`> [!${type}] ${title.trim()}`', '`> [!${type.toUpperCase()}] ${title.trim()}`'],
			['tests/callout.test.ts', "'> [!note]\\n> hello'", "'> [!NOTE]\\n> hello'"],
			['tests/callout.test.ts', "'> [!tip] Heads up\\n> x'", "'> [!TIP] Heads up\\n> x'"],
			['tests/callout.test.ts', "'> [!info]\\n> a\\n>\\n> b'", "'> [!INFO]\\n> a\\n>\\n> b'"],
			['tests/callout.test.ts', "'> [!note]\\n> a\\n> b'", "'> [!NOTE]\\n> a\\n> b'"],
			['tests/callout.test.ts', "'> [!warning]'", "'> [!WARNING]'"],
			['tests/plugin.test.ts', "'before|> [!tip]\\n> middle|after'", "'before|> [!TIP]\\n> middle|after'"],
		],
		expect: 'e2e',
		needsE2E: true,
	},
];

function applyEdits(edits) {
	const originals = new Map();
	for (const [file, find, replace] of edits) {
		if (!originals.has(file)) originals.set(file, readFileSync(file, 'utf8'));
		const current = readFileSync(file, 'utf8');
		if (!current.includes(find)) throw new Error(`mutation anchor not found in ${file}: ${find}`);
		writeFileSync(file, current.replace(find, replace));
	}
	return originals;
}

let failures = 0;
for (const m of MUTATIONS) {
	if (m.needsE2E && !WITH_E2E) {
		console.log(`SKIP  ${m.name} (needs --e2e)`);
		continue;
	}
	const originals = applyEdits(m.edits);
	let report;
	try {
		const verifyArgs = ['scripts/verify.mjs', '--keep-going', ...(m.needsE2E ? ['--e2e'] : [])];
		spawnSync(process.execPath, verifyArgs, { encoding: 'utf8' });
		report = JSON.parse(readFileSync('verify-report.json', 'utf8'));
	} finally {
		for (const [file, text] of originals) writeFileSync(file, text);
	}
	const failed = report.gates.filter((g) => g.status === 'fail').map((g) => g.gate);
	const caught = failed.includes(m.expect);
	if (!caught) failures++;
	console.log(`${caught ? 'OK  ' : 'MISS'}  ${m.name} -> expected ${m.expect}; failed: [${failed.join(', ')}]`);
}
console.log(failures === 0 ? '\nSELFTEST OK' : `\nSELFTEST: ${failures} mutation(s) not caught`);
process.exit(failures === 0 ? 0 : 1);
