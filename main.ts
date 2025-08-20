import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, 
	Setting, TAbstractFile, TFile, FileSystemAdapter } from 'obsidian';
import { exec } from 'child_process';
import { isArray } from 'util';

interface DVCPluginSettings {
	autostage: boolean;
	autopull: boolean;
	autopullExtension: string[];
}

const DEFAULT_SETTINGS: DVCPluginSettings = {
	autostage: false,
	autopull: false,
	autopullExtension: []
}

interface remoteObj {
	name: string;
	path: string;
}

class DVC {
	plug: Plugin;
	cwd: () => string;
	remote: remoteObj[];
	files: TFile[];
	statusBarItem: any;

	constructor(plug: Plugin) {
		this.plug = plug;
		this.cwd = () => {
			if (this.plug.app.vault.adapter instanceof FileSystemAdapter) {
				return this.plug.app.vault.adapter.getBasePath();
			}
			return '';
		};

		this.getFiles();
	}

	shell(command: string, show: boolean = true): Promise<string> {
		return new Promise((resolve, reject) => {
			exec(command, {cwd: this.cwd()}, (err, stdout, stderr) => {
				if (err) {
					console.log(err);
					new Notice(stderr);
					reject(stderr);
					return;
				}
				resolve(stdout);
				if (show) {
					console.log(stdout);
					new Notice(stdout);
				}
			})
		});
	}

	cli(command: string, argument: any, show: boolean = true): void {
		let arg: string = '';
		if (typeof argument == 'string') {
			arg = argument;
		} else {
			if (Array.isArray(argument)) {
				arg = argument.map(file => `"${file.path}"`).join(" ");
			} else {
				arg = `"${argument.path}"`;
			}
		}
		this.shell(`dvc ${command} ${arg}`, show);
	}

	status(show: boolean = true): void {
		this.cli('status', "", show);
	}

	add(arg: any, show: boolean = true): void {
		this.cli('add', arg);
		this.getFiles();
	}

	push(arg: any, show: boolean = true): void {
		this.cli('push', arg);
	}

	pull(arg: any, show: boolean = true): void {
		this.cli('pull', arg);
	}

	remove(arg: any, show: boolean = true): void {
		this.cli('remove', arg);
	}

	getFiles(): void {
		this.files = this.plug.app.vault.getFiles().filter(file => file.extension == 'dvc');
	}

	getRemote(): Promise<remoteObj[]> {
		return new Promise((resolve, reject) => {
			this.shell('dvc remote list')
				.then((data) => {
					const lines: string[] = data.split(/\r?\n/);
					this.remote = lines.map((value) => {
						const substr: string[] = value.split('\t');
						return {name: substr[0], path: substr[1]};
					});
					resolve(this.remote);
				})
				.catch((err) => reject(err));
		});
	}
}

export default class DVCPlugin extends Plugin {
	settings: DVCPluginSettings;
	dvc: DVC;

	async onload() {
		await this.loadSettings();

		this.dvc = new DVC(this);

		// adds git/dvc initalization
		this.addCommand({
			id: 'dvc-init',
			name: 'dvc: init',
			callback: () => {
				this.dvc.shell('git init && dvc init -f');
			}
		});

		// todo create/select dvc remote
		this.addCommand({
			id: 'dvc-remote',
			name: 'dvc: remote',
			callback: () => {
				this.dvc.getRemote().then((data) => {
					console.log(data);
				})
			}
		});

		// adds dvc push all files
		this.addCommand({
			id: 'dvc-push',
			name: 'dvc: push all files',
			callback: () => {
				this.dvc.cli('push', '');
			}
		});

		// adds dvc pull all files
		this.addCommand({
			id: 'dvc-pull',
			name: 'dvc: pull all files',
			callback: () => {
				this.dvc.cli('pull', '');
			}
		});

		// adds dvc garbage cache from workspace
		this.addCommand({
			id: 'dvc-garbage-cache-workspace',
			name: 'dvc: garbage cache from workspace',
			callback: () => {
				this.dvc.cli('gc', '-w -f');
			}
		});

		// adds dvc garbage cache from workspace and remote
		this.addCommand({
			id: 'dvc-garbage-cache-workspace-cloud',
			name: 'dvc: garbage cache from workspace and cloud',
			callback: () => {
				this.dvc.cli('gc', '-w -c -f');
			}
		});

		// adds settings tab
		this.addSettingTab(new DVCSettingTab(this.app, this));

		// adds context menus for file
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				[{com: "add", icon: "book-plus"}, {com: "push", icon: "book-up"},
					{com: "pull", icon: "book-down"}, {com: "remove", icon: "book-minus"}]
						.map(element => {
							menu.addItem((item) => {
								item
								.setTitle(`dvc: ${element.com}`)
								.setIcon(element.icon)
								.onClick(async () => {
									this.dvc.cli(element.com, [file]);
								});
						});
				})
			})
		);

		// adds context menus for files
		this.registerEvent(
			this.app.workspace.on('files-menu', (menu, files) => {
				[{com: "add", icon: "book-plus"}, {com: "push", icon: "book-up"},
					{com: "pull", icon: "book-down"}, {com: "remove", icon: "book-minus"}]
						.map(element => {
							menu.addItem((item) => {
								item
								.setTitle(`dvc: ${element.com}`)
								.setIcon(element.icon)
								.onClick(async () => {
									this.dvc.cli(element.com, files);
								});
						});
				})
			})
		);

		// adds dvc auto pull attachment files
		this.registerEvent(
			this.app.workspace.on('file-open', async (file) => {
				if (!this.dvc.files.length) {
					this.dvc.getFiles();
				}
				if (file && this.settings.autopull && this.dvc.files.length) {
					const fileCache = this.app.metadataCache.getFileCache(file);
					if (fileCache && fileCache.embeds) {
						const dvcFiles = fileCache.embeds.map(embed => {
							if (this.settings.autopullExtension.some(item => embed.link.includes(item))) {
								return this.dvc.files.find(dvcFile => dvcFile.basename === embed.link);
							}
							return null;
						})
						if (dvcFiles) {
							this.dvc.pull(dvcFiles.filter(item => item));
						}
					}
				}
			})
		);

		this.dvc.status();

	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

}

class DVCSettingTab extends PluginSettingTab {
	plugin: DVCPlugin;

	constructor(app: App, plugin: DVCPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Auto stage')
			.setDesc('Enable git stage files after dvc adding')
			.addToggle(component => component
				.setValue(this.plugin.settings.autostage)
				.onChange(async (value) => {
					this.plugin.dvc.cli('config', `--local core.autostage ${value}`, false);
					this.plugin.settings.autostage = value;
					await this.plugin.saveSettings();
				}))

		new Setting(containerEl)
			.setName('Auto data pull')
			.setDesc('Enable file attachment pull')
			.addToggle(component => component
				.setValue(this.plugin.settings.autopull)
				.onChange(async (value) => {
					this.plugin.settings.autopull = value;
					await this.plugin.saveSettings();
				}))
	
		new Setting(containerEl)
			.setName('Extension list of auto pull mode')
			.setDesc('File attachment extension list to auto pull')
			.addText(text => text
				.setPlaceholder('Enter a list of extensions separated by spaces')
				.setValue(this.plugin.settings.autopullExtension.join(" "))
				.onChange(async (value) => {
					this.plugin.settings.autopullExtension = value.trim().replace(/\s+/g, " ").split(" ");
					await this.plugin.saveSettings();
				}));

	}
}
