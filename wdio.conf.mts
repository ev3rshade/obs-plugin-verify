import * as path from 'path';

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./e2e/specs/**/*.e2e.ts'],
	maxInstances: 1,
	capabilities: [{
		browserName: 'obsidian',
		// Pin a version for reproducible verification; bump deliberately.
		browserVersion: process.env.OBSIDIAN_VERSION ?? 'latest',
		'wdio:obsidianOptions': {
			installerVersion: process.env.OBSIDIAN_INSTALLER_VERSION ?? 'earliest',
			plugins: ['.'],
			vault: 'e2e/vaults/simple',
			// Optional: use a pre-downloaded Obsidian instead of auto-download
			// (useful behind proxies or offline CI).
			...(process.env.OBSIDIAN_BINARY ? { binaryPath: process.env.OBSIDIAN_BINARY } : {}),
			...(process.env.OBSIDIAN_ASAR ? { appPath: process.env.OBSIDIAN_ASAR } : {}),
		},
	}],
	services: ['obsidian'],
	reporters: ['obsidian'],
	// OBSIDIAN_CACHE_DIR lets several checkouts (e.g. harness worktrees) share one download.
	cacheDir: process.env.OBSIDIAN_CACHE_DIR ?? path.resolve('.obsidian-cache'),
	mochaOpts: { ui: 'bdd', timeout: 120000 },
	logLevel: 'warn',
};
