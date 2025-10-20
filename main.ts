import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, 
	Setting, TAbstractFile, TFile, TFolder, Menu, FileSystemAdapter, 
	CachedMetadata, Modal, normalizePath} from 'obsidian';
import { exec } from 'child_process';

interface DVCPluginSettings {
	autostage: boolean;
	autopull: boolean;
	autopullExtension: string[];
	excludeExtension: string[];
	startupstatus: boolean;
}

const DEFAULT_SETTINGS: DVCPluginSettings = {
	autostage: false,
	autopull: false,
	autopullExtension: [],
	excludeExtension: [],
	startupstatus: false,
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
	lock: string | null = null;
	process: Promise<string> | null = null;

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
				resolve(this.getLock())
				if (show) {
					console.log(stdout);
					new Notice(stdout);
				}
			})
		});
	}

	cli(command: string, argument: string | TFile[] | TFolder[], show: boolean = true): void {
		this.getLock().then((lock: string) => {
				let arg: string | TFile[] | TFolder[] = argument
				if (Array.isArray(arg)) {
					if (arg.length > 0) {
						arg = arg.map(item => ((item instanceof TFile) || (item instanceof TFolder)) ? 
							`"${item.path}"` : item).join(" ")
					} else {
						return
					}
				}
				this.process = this.shell(`dvc ${command} ${arg}`, show)
		}).catch(error => {
			console.error("An error occurred:", error.message);
			new Notice(error.message);
		})
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
		this.files = this.plug.app.vault.getFiles().filter(file => file.extension === 'dvc');
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

	getLock(): Promise<string> {
		return this.plug.app.vault.adapter.read(normalizePath(".dvc/tmp/lock"))
	}

	getIndexed(absFiles: TAbstractFile[] | TFile[] | TFolder[]): TFile[] {
		let filtAbsFiles: any[] = absFiles.map(absFile => {
			let name: string
			if (absFile instanceof TFile) {
				name = absFile.basename
			} else if (absFile instanceof TFolder) {
				name = absFile.name
			}
			return this.files.find(f => f.basename === name)
		}).filter(Boolean)
		return [...new Set(filtAbsFiles)]
	}

	getAttachments(file: CachedMetadata | null, extensions: string[]): TFile[] {
		let attachLinks: string[] = []
		
		let temp = [file?.links, file?.frontmatterLinks, file?.embeds].filter(Boolean).map(links => {
			attachLinks = attachLinks.concat(links.map(l => l.link))
		})

		attachLinks = [...new Set(attachLinks)]

		if (!this.files.length) {
			this.getFiles();
		}

		let dvcfiles: any[] = attachLinks.map(attachLink => {
			if (extensions.length > 0) {
				if (extensions.some(item => attachLink.includes(item))) {
					return this.files.find(file => file.basename === attachLink)
				} else {
					return null;
				}
			} else {
				return this.files.find(file => file.basename === attachLink)
			}
		}).filter(Boolean)

		return dvcfiles
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
			name: 'initialize',
			callback: () => {
				this.dvc.shell('git init && dvc init -f');
			}
		});

		// todo create/select dvc remote
		this.addCommand({
			id: 'dvc-remote',
			name: 'list remote',
			callback: () => {
				this.dvc.getRemote().then((data) => {
					console.log(data);
				})
			}
		});

		// adds dvc push all files
		this.addCommand({
			id: 'dvc-push',
			name: 'push all files',
			callback: () => {
				this.dvc.cli('push', '');
			}
		});

		// adds dvc pull all files
		this.addCommand({
			id: 'dvc-pull',
			name: 'pull all files',
			callback: () => {
				this.dvc.cli('pull', '');
			}
		});

		// adds dvc garbage cache from workspace
		this.addCommand({
			id: 'dvc-garbage-cache-workspace',
			name: 'garbage cache from workspace',
			callback: () => {
				this.dvc.cli('gc', '-w -f');
			}
		});

		// adds dvc garbage cache from workspace and remote
		this.addCommand({
			id: 'dvc-garbage-cache-workspace-cloud',
			name: 'garbage cache from workspace and cloud',
			callback: () => {
				this.dvc.cli('gc', '-w -c -f');
			}
		});

		// adds dvc export attachemnt links
		this.addCommand({
			id: 'dvc-get-attach-links',
			name: 'export attachemnt links',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const file: TFile | null = this.app.workspace.getActiveFile();				
				if (file instanceof TFile) {
					const fileCache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
					const dvcFiles: TFile[] = this.dvc.getAttachments(fileCache, [])
					if (dvcFiles.length > 0) {
						let section: string = ["\n```\n", ...dvcFiles.map(dvcFile => `"${dvcFile.path}"\n`), "```\n"].join("")
						this.app.vault.adapter.append(file.path, section)
					}
				}
			
			}
		});

		// adds settings tab
		this.addSettingTab(new DVCSettingTab(this.app, this));

		// adds context menus for file
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				this.buildFileMenu(menu, [file])
			})
		);

		// adds context menus for files
		this.registerEvent(
			this.app.workspace.on('files-menu', (menu, files) => {
				this.buildFileMenu(menu, files)
			})
		);

		// adds dvc auto pull attachment files
		this.registerEvent(
			this.app.workspace.on('file-open', (file: TFile | null) => {
				if (file instanceof TFile) {
					if (this.settings.autopull) {
						const fileCache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
						const dvcFiles: TFile[] = this.dvc.getAttachments(fileCache, this.settings.autopullExtension)
						this.dvc.pull(dvcFiles)
					}
				}
			})
		)

		if (this.settings.startupstatus) {
			this.dvc.status();
		}

	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	buildFileMenu(menu: Menu, files: TAbstractFile[]): void {
		const pattern = [
			{command: "add", icon: "book-plus"}, 
			{command: "push", icon: "book-up"},
			{command: "pull", icon: "book-down"}, 
			{command: "remove", icon: "book-minus"}
		]
	
		let indexed = this.dvc.getIndexed(files)

		let sortPattern: any[] = []

		let args: TAbstractFile[] | TFile[]

		if (indexed.length > 0) {
			args = indexed
			sortPattern = sortPattern.concat(pattern[1], pattern[2], pattern[3])
		} else {
			args = files.filter(file => this.settings.excludeExtension.some(item => {
					if (file instanceof TFile) {
						return file.extension.includes(item)
					} else {
						return false
					}
				})
			)
			if (args.length > 0) {
				sortPattern = []
			} else {
				sortPattern = sortPattern.concat(pattern[0])
			}
		}

		sortPattern.map(element => {
			menu.addItem((item) => {
				item
				.setTitle(`dvc: ${element.command}`)
				.setIcon(element.icon)
				.onClick(() => {
					this.dvc.cli(element.command, args);
				});
			});
		})
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

		new Setting(containerEl)
			.setName('Auto check status')
			.setDesc('Enable execution `dvc status` at startup')
			.addToggle(component => component
				.setValue(this.plugin.settings.startupstatus)
				.onChange(async (value) => {
					this.plugin.settings.startupstatus = value;
					await this.plugin.saveSettings();
				}))

		new Setting(containerEl)
			.setName('Extension list to ignore by plugin')
			.setDesc('File attachment extension list to ignore by plugin')
			.addText(text => text
				.setPlaceholder('Enter a list of extensions separated by spaces')
				.setValue(this.plugin.settings.excludeExtension.join(" "))
				.onChange(async (value) => {
					this.plugin.settings.excludeExtension = value.trim().replace(/\s+/g, " ").split(" ");
					await this.plugin.saveSettings();
				}));

	}
}
