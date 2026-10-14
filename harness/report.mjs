#!/usr/bin/env node
// Aggregate harness/results/results.jsonl across runs, grouped by
// task + agent + model + label, to compare models, prompts or settings.
//   node harness/report.mjs                # all runs
//   node harness/report.mjs --task unwrap-callout
//   node harness/report.mjs --since 2026-10-01
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const file = path.join(process.cwd(), 'harness', 'results', 'results.jsonl');
if (!fs.existsSync(file)) {
	console.log('no results yet (harness/results/results.jsonl not found)');
	process.exit(0);
}
const since = opt('--since')?.replaceAll('-', '');
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
	.filter((r) => r.type === 'attempt')
	.filter((r) => !opt('--task') || r.task === opt('--task'))
	.filter((r) => !since || r.run_id.slice(0, 8) >= since);

const groups = new Map();
for (const r of rows) {
	const key = [r.task, r.agent, r.model, r.label || '-', r.e2e ? 'e2e' : 'no-e2e'].join(' | ');
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push(r);
}

console.log('| task | agent | model/cmd | label | e2e | attempts | solved | first try | mean iters (solved) | violations | tokens in/out |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const [key, list] of groups) {
	const solved = list.filter((r) => r.solved);
	const first = list.filter((r) => r.solved_at_iter === 1);
	const mean = solved.length ? (solved.reduce((s, r) => s + r.iterations, 0) / solved.length).toFixed(2) : '-';
	const pct = (n) => `${n}/${list.length} (${Math.round((100 * n) / list.length)}%)`;
	const tin = list.reduce((s, r) => s + (r.input_tokens ?? 0), 0);
	const tout = list.reduce((s, r) => s + (r.output_tokens ?? 0), 0);
	const viol = list.reduce((s, r) => s + (r.violations ?? 0), 0);
	console.log(`| ${key} | ${list.length} | ${pct(solved.length)} | ${pct(first.length)} | ${mean} | ${viol} | ${tin}/${tout} |`);
}
