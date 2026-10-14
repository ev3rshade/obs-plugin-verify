import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';

describe('callout-wrapper in real Obsidian', function () {
	beforeEach(async function () {
		await obsidianPage.resetVault();
	});

	it('loads without errors', async function () {
		const loaded = await browser.executeObsidian(({ app }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return Boolean((app as any).plugins.plugins['callout-wrapper']);
		});
		expect(loaded).toBe(true);
	});

	it('wraps the selected line via the command', async function () {
		await obsidianPage.openFile('Note.md');
		await browser.executeObsidian(({ app }) => {
			const editor = app.workspace.activeEditor?.editor;
			if (!editor) throw new Error('no active editor');
			editor.setSelection({ line: 1, ch: 0 }, { line: 1, ch: 11 });
		});
		await browser.executeObsidianCommand('callout-wrapper:wrap-selection');
		// Give the vault time to flush the edit to disk.
		await browser.waitUntil(async () => (await obsidianPage.read('Note.md')).includes('[!note]'), { timeout: 10000 });
		expect(await obsidianPage.read('Note.md')).toBe('first line\n> [!note]\n> second line\n');
	});
});
