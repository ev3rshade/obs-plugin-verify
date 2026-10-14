Recorded response: first try with a header-regex bug.

<file path="src/callout.ts">
// Pure logic, no imports from 'obsidian', so it can be unit tested in Node.

export const CALLOUT_TYPES = [
	'note',
	'tip',
	'info',
	'warning',
	'danger',
	'quote',
] as const;

export type CalloutType = (typeof CALLOUT_TYPES)[number];

export function isCalloutType(value: string): value is CalloutType {
	return (CALLOUT_TYPES as readonly string[]).includes(value);
}

/**
 * Wrap text in an Obsidian callout block.
 * Every line is prefixed with "> ", blank lines become ">" so the
 * callout is not broken in two.
 */
export function toCallout(
	text: string,
	type: CalloutType,
	title?: string,
): string {
	const header = title && title.trim().length > 0
		? `> [!${type}] ${title.trim()}`
		: `> [!${type}]`;
	const body = text
		.replace(/\r\n/g, '\n')
		.replace(/\n+$/, '')
		.split('\n')
		.map((line) => (line.length === 0 ? '>' : `> ${line}`));
	if (body.length === 1 && body[0] === '>') {
		return header;
	}
	return [header, ...body].join('\n');
}

const HEADER = /^> \[!(\w+)\]()(?: (.*))?$/;

/**
 * Inverse of toCallout: turn a callout block back into plain text.
 * Returns the input unchanged if it does not start with a callout header.
 */
export function fromCallout(text: string): string {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const match = HEADER.exec(lines[0] ?? '');
	if (!match) {
		return text;
	}
	const out: string[] = [];
	const title = (match[3] ?? '').trim();
	if (title.length > 0) {
		out.push(title);
	}
	for (const line of lines.slice(1)) {
		if (line.startsWith('> ')) {
			out.push(line.slice(2));
		} else if (line.startsWith('>')) {
			out.push(line.slice(1));
		} else {
			out.push(line);
		}
	}
	return out.join('\n');
}
</file>

<file path="src/main.ts">
import { Editor, Plugin } from 'obsidian';
import { fromCallout, toCallout, isCalloutType } from './callout';
import {
	CalloutWrapperSettings,
	CalloutWrapperSettingTab,
	DEFAULT_SETTINGS,
} from './settings';

export default class CalloutWrapper extends Plugin {
	settings: CalloutWrapperSettings = { ...DEFAULT_SETTINGS };

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'wrap-selection',
			name: 'Wrap selection in callout',
			editorCallback: (editor: Editor) => {
				const selection = editor.getSelection();
				editor.replaceSelection(
					toCallout(selection, this.settings.defaultType),
				);
			},
		});

		this.addCommand({
			id: 'unwrap-selection',
			name: 'Unwrap callout in selection',
			editorCallback: (editor: Editor) => {
				editor.replaceSelection(fromCallout(editor.getSelection()));
			},
		});

		this.addSettingTab(new CalloutWrapperSettingTab(this.app, this));
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<CalloutWrapperSettings> | null;
		const merged = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
		// Never trust stored data blindly: fall back if the type is unknown.
		if (!isCalloutType(merged.defaultType)) {
			merged.defaultType = DEFAULT_SETTINGS.defaultType;
		}
		this.settings = merged;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
</file>
