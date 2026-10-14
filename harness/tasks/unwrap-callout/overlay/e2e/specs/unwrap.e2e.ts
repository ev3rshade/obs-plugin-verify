// Held-out acceptance test in real Obsidian for the unwrap-callout task.
import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';

describe('unwrap-selection in real Obsidian', function () {
	beforeEach(async function () {
		await obsidianPage.resetVault('e2e/vaults/simple', {
			'Callout.md': '> [!tip] Title\n> one\n>\n> two\n',
		});
	});

	it('turns the selected callout back into plain text', async function () {
		await obsidianPage.openFile('Callout.md');
		await browser.executeObsidian(({ app }) => {
			const editor = app.workspace.activeEditor?.editor;
			if (!editor) throw new Error('no active editor');
			editor.setSelection({ line: 0, ch: 0 }, { line: 3, ch: 5 });
		});
		await browser.executeObsidianCommand('callout-wrapper:unwrap-selection');
		await browser.waitUntil(async () => !(await obsidianPage.read('Callout.md')).startsWith('>'), { timeout: 10000 });
		expect(await obsidianPage.read('Callout.md')).toBe('Title\none\n\ntwo\n');
	});
});
