import { describe, it, expect } from 'vitest';
import { App, Editor } from 'obsidian';
import CalloutWrapper from '../src/main';

async function loaded(stored: unknown = null) {
	const plugin = new CalloutWrapper(new App(), {} as never);
	(plugin as unknown as { stored: unknown }).stored = stored;
	await plugin.onload();
	return plugin as CalloutWrapper & { commands: { id: string; editorCallback?: (e: Editor) => void }[] };
}

describe('plugin wiring', () => {
	it('registers the wrap command with a stable id', async () => {
		const p = await loaded();
		expect(p.commands.map((c) => c.id)).toContain('wrap-selection');
	});

	it('wraps the editor selection using the saved default type', async () => {
		const p = await loaded({ defaultType: 'tip' });
		const editor = new Editor('before|middle|after', 7, 13);
		p.commands.find((c) => c.id === 'wrap-selection')!.editorCallback!(editor);
		expect(editor.text).toBe('before|> [!tip]\n> middle|after');
	});

	it('falls back to the default when stored settings are corrupt', async () => {
		const p = await loaded({ defaultType: 'not-a-type' });
		expect(p.settings.defaultType).toBe('note');
	});

	it('persists settings round trip', async () => {
		const p = await loaded();
		p.settings.defaultType = 'danger';
		await p.saveSettings();
		await p.loadSettings();
		expect(p.settings.defaultType).toBe('danger');
	});
});
