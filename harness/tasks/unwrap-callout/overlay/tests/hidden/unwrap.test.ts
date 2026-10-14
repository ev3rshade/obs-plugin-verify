// Held-out acceptance tests for the unwrap-callout task.
// Installed by the harness; the agent may read but not change them.
import { describe, it, expect } from 'vitest';
import { App, Editor } from 'obsidian';
import { fromCallout, toCallout } from '../../src/callout';
import CalloutWrapper from '../../src/main';

describe('fromCallout', () => {
	it('unwraps a simple callout', () => {
		expect(fromCallout('> [!note]\n> hello')).toBe('hello');
	});

	it('keeps the title as the first line', () => {
		expect(fromCallout('> [!tip] Heads up\n> x')).toBe('Heads up\nx');
	});

	it('accepts fold markers and unknown types', () => {
		expect(fromCallout('> [!faq]- Folded\n> body')).toBe('Folded\nbody');
		expect(fromCallout('> [!custom-thing]+\n> body')).toBe('body');
	});

	it('turns lone > lines into blank lines', () => {
		expect(fromCallout('> [!info]\n> a\n>\n> b')).toBe('a\n\nb');
	});

	it('handles a > prefix without a space', () => {
		expect(fromCallout('> [!note]\n>tight')).toBe('tight');
	});

	it('normalizes CRLF', () => {
		expect(fromCallout('> [!note]\r\n> a\r\n> b')).toBe('a\nb');
	});

	it('returns non-callout text unchanged', () => {
		expect(fromCallout('just text')).toBe('just text');
		expect(fromCallout('> plain quote\n> more')).toBe('> plain quote\n> more');
	});

	it('returns an empty string for a bare header', () => {
		expect(fromCallout('> [!warning]')).toBe('');
	});

	it('round trips with toCallout', () => {
		const samples = ['one', 'a\nb', 'a\n\nb', '  indented\n- list', ''];
		for (const s of samples) {
			expect(fromCallout(toCallout(s, 'note'))).toBe(s);
		}
	});
});

describe('unwrap command', () => {
	it('is registered and unwraps the selection', async () => {
		const plugin = new CalloutWrapper(new App(), {} as never);
		await plugin.onload();
		const commands = (plugin as unknown as { commands: { id: string; name: string; editorCallback?: (e: Editor) => void }[] }).commands;
		const cmd = commands.find((c) => c.id === 'unwrap-selection');
		expect(cmd?.name).toBe('Unwrap callout in selection');
		const editor = new Editor('> [!note]\n> hi');
		cmd?.editorCallback?.(editor);
		expect(editor.text).toBe('hi');
		expect(commands.some((c) => c.id === 'wrap-selection')).toBe(true);
	});
});
