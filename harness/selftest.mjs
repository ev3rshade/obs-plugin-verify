#!/usr/bin/env node
// Self-test for the harness ("test the test rig"). Runs the harness on the
// unwrap-callout task with recorded responses and checks the recorded outcome.
// No API key or network needed: the api agent talks to a local fake server.
//
// Run from the plugin root, with a clean git tree:
//   node harness/selftest.mjs          # without e2e (about 2-3 minutes)
//   node harness/selftest.mjs --e2e    # reference solution also checked in real Obsidian

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const WITH_E2E = process.argv.includes('--e2e');
const TASK = 'unwrap-callout';
const FIX = 'harness/fixtures/fix-after-feedback';
const APPLY = path.join(ROOT, 'harness', 'test', 'apply-response.mjs');
const REF = path.join(ROOT, 'harness', 'tasks', TASK, 'reference.md');
const TAMPER = path.join(ROOT, 'harness', 'test', 'tamper-config.md');

function runHarness(args, env = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['harness/run.mjs', '--task', TASK, '--quiet', ...args], {
			cwd: ROOT, env: { ...process.env, ...env },
		});
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('close', () => {
			const m = out.match(/results: (\S+)/);
			if (!m) return resolve({ out, error: 'no results line' });
			const s = JSON.parse(fs.readFileSync(path.join(ROOT, m[1], 'summary.json'), 'utf8'));
			resolve({ out, summary: s.summary, attempts: s.attempts });
		});
	});
}

// Minimal stand-in for the Anthropic Messages API that replays fixture responses.
function fakeApi(responses) {
	const seen = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			const json = JSON.parse(body);
			seen.push({ path: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], model: json.model, messages: json.messages.length });
			const text = responses[Math.min(seen.length, responses.length) - 1];
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({
				content: [{ type: 'text', text }], stop_reason: 'end_turn',
				usage: { input_tokens: 1000 * seen.length, output_tokens: 100 },
			}));
		});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

const cases = [
	{
		name: 'reference solution solves on first try',
		args: ['--agent', 'replay', '--replay', REF, ...(WITH_E2E ? ['--e2e'] : [])],
		check: (r) => r.summary.solved_first_try === 1 && r.attempts[0].baseline_failed_gate !== null,
	},
	{
		name: 'buggy first try is fixed after feedback',
		args: ['--agent', 'replay', '--replay', FIX],
		check: (r) => r.summary.solved === 1 && r.attempts[0].solved_at_iter === 2 && r.attempts[0].path === 'unit > PASS',
	},
	{
		name: 'cheating writes are blocked and recorded',
		args: ['--agent', 'replay', '--replay', 'harness/fixtures/cheater', '--max-iters', '2'],
		check: (r) => r.summary.solved === 0 && r.summary.violations === 6,
	},
	{
		name: 'api agent: request shape, conversation and token accounting',
		api: true,
		args: ['--agent', 'api', '--model', 'test-model'],
		check: (r, seen) =>
			r.summary.solved === 1 && r.attempts[0].solved_at_iter === 2 &&
			r.summary.input_tokens === 3000 && r.summary.output_tokens === 200 &&
			seen.length === 2 && seen[0].path === '/v1/messages' && seen[0].key === 'test-key' &&
			seen[0].version === '2023-06-01' && seen[0].model === 'test-model' &&
			seen[0].messages === 1 && seen[1].messages === 3,
	},
	{
		name: 'command agent: honest edits solve the task',
		args: ['--agent', 'command', '--cmd', `node ${JSON.stringify(APPLY)} ${JSON.stringify(REF)}`],
		check: (r) => r.summary.solved_first_try === 1 && r.summary.violations === 0,
	},
	{
		name: 'command agent: weakening lint config fails the protected gate',
		args: ['--agent', 'command', '--cmd', `node ${JSON.stringify(APPLY)} ${JSON.stringify(REF)} ${JSON.stringify(TAMPER)}`, '--max-iters', '1'],
		check: (r) => r.summary.solved === 0 && r.attempts[0].path === 'protected' && r.summary.violations === 1,
	},
];

let failures = 0;
for (const c of cases) {
	let api = null;
	let env = {};
	if (c.api) {
		const responses = ['iter1.md', 'iter2.md'].map((f) => fs.readFileSync(path.join(ROOT, FIX, f), 'utf8'));
		api = await fakeApi(responses);
		env = { ANTHROPIC_API_KEY: 'test-key', HARNESS_API_URL: `http://127.0.0.1:${api.port}` };
	}
	const r = await runHarness(c.args, env);
	if (api) api.server.close();
	let ok = false;
	try {
		ok = !r.error && c.check(r, api?.seen ?? []);
	} catch {
		ok = false;
	}
	if (!ok) failures++;
	const detail = r.attempts ? r.attempts.map((a) => `path=${a.path} violations=${a.violations}`).join('; ') : r.error;
	console.log(`${ok ? 'OK  ' : 'FAIL'}  ${c.name}  [${detail}]`);
	if (!ok) console.log(r.out.split('\n').slice(-25).join('\n'));
}
console.log(failures === 0 ? '\nHARNESS SELFTEST OK' : `\nHARNESS SELFTEST: ${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
