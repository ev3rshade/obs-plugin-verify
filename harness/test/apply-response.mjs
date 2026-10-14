#!/usr/bin/env node
// Test helper that pretends to be a command-line coding agent: it writes every
// <file path="..."> block from a response file into the current directory,
// with NO allowlist (a real agent can touch anything). Used by selftest.mjs.
//   node apply-response.mjs <response.md> [<extra-response.md> ...]
import fs from 'node:fs';
import path from 'node:path';

for (const file of process.argv.slice(2)) {
	const text = fs.readFileSync(file, 'utf8');
	for (const m of text.matchAll(/<file path="([^"]+)">\r?\n?([\s\S]*?)<\/file>/g)) {
		const target = path.resolve(process.cwd(), m[1]);
		if (!target.startsWith(process.cwd() + path.sep)) continue; // stay inside the worktree
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, m[2]);
	}
}
// Drain stdin (the prompt) so the parent does not see EPIPE.
process.stdin.resume();
process.stdin.on('data', () => undefined);
process.stdin.on('end', () => console.log('applied'));
