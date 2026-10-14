import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'tsconfig.test.json',
		'tests',
		'e2e',
		'scripts',
		'harness',
		'vitest.config.ts',
		'wdio.conf.mts',
		'.obsidian-cache',
		'verify-report.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// Declarative settings (getSettingDefinitions) need Obsidian 1.13+.
			// manifest.json minAppVersion is 1.0.0, so we keep display().
			// Revisit if minAppVersion is raised to 1.13.0 or later.
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
		},
	},
);
