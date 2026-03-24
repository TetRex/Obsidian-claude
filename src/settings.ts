import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudeAssistantPlugin from "./main";

export interface ClaudeAssistantSettings {
	apiKey: string;
	model: string;
	customSystemPrompt: string;
	monthlyLimitDollars: number; // 0 = no limit
	usageMonth: string;          // "2026-03"
	usageDollars: number;        // accumulated spend this month
}

export const DEFAULT_SETTINGS: ClaudeAssistantSettings = {
	apiKey: "",
	model: "claude-sonnet-4-6",
	customSystemPrompt: "",
	monthlyLimitDollars: 0,
	usageMonth: "",
	usageDollars: 0,
};

const AVAILABLE_MODELS = [
	{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
	{ value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export class ClaudeSettingTab extends PluginSettingTab {
	plugin: ClaudeAssistantPlugin;

	constructor(app: App, plugin: ClaudeAssistantPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Instructions file ──────────────────────────────────
		const instructionFile = (this.app as App & { vault: { getAbstractFileByPath: (p: string) => unknown } })
			.vault.getAbstractFileByPath("CLAUDE.md");

		new Setting(containerEl)
			.setName("Vault instructions (CLAUDE.md)")
			.setDesc(
				instructionFile
					? "Instructions file exists at vault root. Open it to edit your AI instructions."
					: "No CLAUDE.md found. Create one with a starter template to customise how Claude behaves."
			)
			.addButton((btn) => {
				if (instructionFile) {
					btn.setButtonText("Open CLAUDE.md").onClick(() => {
						const leaf = this.app.workspace.getLeaf(false);
						const file = (this.app as App & { vault: { getAbstractFileByPath: (p: string) => unknown } })
							.vault.getAbstractFileByPath("CLAUDE.md");
						if (file) leaf.openFile(file as Parameters<typeof leaf.openFile>[0]);
					});
				} else {
					btn.setButtonText("Create CLAUDE.md").setCta().onClick(async () => {
						const created = await this.plugin.vaultInstructions?.createStarterTemplate();
						if (created) {
							new Notice("CLAUDE.md created at vault root.");
							const leaf = this.app.workspace.getLeaf(false);
							const file = (this.app as App & { vault: { getAbstractFileByPath: (p: string) => unknown } })
								.vault.getAbstractFileByPath("CLAUDE.md");
							if (file) leaf.openFile(file as Parameters<typeof leaf.openFile>[0]);
						} else {
							new Notice("CLAUDE.md already exists.");
						}
						this.display();
					});
				}
			});

		containerEl.createEl("hr");

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Your Anthropic API key. Stored locally in plugin data.")
			.addText((text) =>
				text
					.setPlaceholder("sk-ant-...")
					.setValue(this.plugin.settings.apiKey)
					.then((t) => {
						t.inputEl.type = "password";
						t.inputEl.style.width = "100%";
					})
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Which Claude model to use")
			.addDropdown((dropdown) => {
				for (const m of AVAILABLE_MODELS) {
					dropdown.addOption(m.value, m.label);
				}
				dropdown
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Custom system prompt")
			.setDesc(
				"Additional instructions appended to the system prompt. Leave empty for defaults."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("e.g. Always respond in Japanese...")
					.setValue(this.plugin.settings.customSystemPrompt)
					.then((t) => {
						t.inputEl.rows = 4;
						t.inputEl.style.width = "100%";
					})
					.onChange(async (value) => {
						this.plugin.settings.customSystemPrompt = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Monthly spending limit")
			.setDesc("Stop sending requests when this dollar amount is reached in a calendar month. Set to 0 for no limit.")
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(
						this.plugin.settings.monthlyLimitDollars > 0
							? String(this.plugin.settings.monthlyLimitDollars)
							: ""
					)
					.then((t) => {
						t.inputEl.type = "number";
						t.inputEl.min = "0";
						t.inputEl.step = "0.5";
						t.inputEl.style.width = "80px";
						const suffix = t.inputEl.insertAdjacentElement("afterend", document.createElement("span")) as HTMLElement;
						suffix.textContent = "$";
						suffix.style.marginLeft = "4px";
					})
					.onChange(async (value) => {
						const parsed = parseFloat(value);
						this.plugin.settings.monthlyLimitDollars =
							isNaN(parsed) || parsed < 0 ? 0 : parsed;
						await this.plugin.saveSettings();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Reset usage").onClick(async () => {
					this.plugin.settings.usageDollars = 0;
					this.plugin.settings.usageMonth = "";
					await this.plugin.saveSettings();
					new Notice("Usage counter reset.");
					this.display();
				})
			);

		const usageDollars = this.plugin.settings.usageDollars;
		const limitDollars = this.plugin.settings.monthlyLimitDollars;
		const usageDesc =
			limitDollars > 0
				? `$${usageDollars.toFixed(4)} used of $${limitDollars.toFixed(2)} this month`
				: `$${usageDollars.toFixed(4)} used this month`;
		new Setting(containerEl)
			.setName("Current usage")
			.setDesc(usageDesc);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Send a test message to verify your API key works")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					if (!this.plugin.settings.apiKey) {
						new Notice("Please enter an API key first.");
						return;
					}
					button.setButtonText("Testing...");
					button.setDisabled(true);
					try {
						const client = this.plugin.getClient();
						await client.testConnection();
						new Notice("Connection successful!");
					} catch (e) {
						const msg =
							e instanceof Error ? e.message : "Unknown error";
						new Notice(`Connection failed: ${msg}`);
					} finally {
						button.setButtonText("Test");
						button.setDisabled(false);
					}
				})
			);
	}
}
