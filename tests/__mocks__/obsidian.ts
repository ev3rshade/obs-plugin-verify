// Minimal stand-in for the 'obsidian' package, which only exists inside the app.
// Stub only what the plugin touches; record calls so tests can assert on them.

export class App {}

export interface Command {
	id: string;
	name: string;
	editorCallback?: (editor: Editor) => void;
	callback?: () => void;
}

export class Plugin {
	app: App;
	commands: Command[] = [];
	settingTabs: unknown[] = [];
	stored: unknown = null;

	constructor(app: App = new App(), _manifest?: unknown) {
		this.app = app;
	}
	addCommand(cmd: Command): Command {
		this.commands.push(cmd);
		return cmd;
	}
	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}
	async loadData(): Promise<unknown> {
		return this.stored;
	}
	async saveData(data: unknown): Promise<void> {
		this.stored = structuredClone(data);
	}
}

export class PluginSettingTab {
	containerEl = { empty: () => undefined };
	constructor(public app: App, public plugin: Plugin) {}
}

export class DropdownComponent {
	options: Record<string, string> = {};
	value = '';
	addOption(value: string, display: string): this { this.options[value] = display; return this; }
	setValue(value: string): this { this.value = value; return this; }
	onChange(_cb: (value: string) => unknown): this { return this; }
}

export class Setting {
	constructor(_el: unknown) {}
	setName(_name: string): this { return this; }
	setDesc(_desc: string): this { return this; }
	addDropdown(cb: (d: DropdownComponent) => unknown): this { cb(new DropdownComponent()); return this; }
}

// Fake editor that behaves like a single text buffer with a selection.
export class Editor {
	constructor(public text: string, public selStart = 0, public selEnd = text.length) {}
	getSelection(): string {
		return this.text.slice(this.selStart, this.selEnd);
	}
	replaceSelection(replacement: string): void {
		this.text = this.text.slice(0, this.selStart) + replacement + this.text.slice(this.selEnd);
		this.selEnd = this.selStart + replacement.length;
	}
}
