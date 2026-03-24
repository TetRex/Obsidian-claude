import type { App} from "obsidian";
import { Notice, PluginSettingTab, Setting } from "obsidian";
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
		void this.renderAsync();
	}

	private async renderAsync(): Promise<void> {
		// ── Instructions file ──────────────────────────────────
		const instructionExists = await this.app.vault.adapter.exists(".claude.md");

		// Clear after the async work so concurrent calls don't produce duplicate settings
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Vault instructions (.claude.md)")
			.setDesc(
				instructionExists
					? "Instructions file exists at vault root. Open it to edit your AI instructions."
					: "No .claude.md found. Create one with a starter template to customise how Claude behaves."
			)
			.addButton((btn) => {
				if (instructionExists) {
					btn.setButtonText("Delete .claude.md").onClick(async () => {
						await this.app.vault.adapter.remove(".claude.md");
						new Notice(".claude.md deleted.");
						this.display();
					});
				} else {
					btn.setButtonText("Create .claude.md").setCta().onClick(async () => {
						const created = await this.plugin.vaultInstructions?.createStarterTemplate();
						if (created) {
							new Notice(".claude.md created at vault root.");
						} else {
							new Notice(".claude.md already exists.");
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
						t.inputEl.addClass("claude-setting-input-full");
					})
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Which claude model to use")
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
					.setPlaceholder("Your custom prompt")
					.setValue(this.plugin.settings.customSystemPrompt)
					.then((t) => {
						t.inputEl.rows = 4;
						t.inputEl.addClass("claude-setting-input-full");
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
						t.inputEl.addClass("claude-setting-input-number");
						const suffix = t.inputEl.insertAdjacentElement("afterend", document.createElement("span")) as HTMLElement;
						suffix.textContent = "$";
						suffix.addClass("claude-setting-suffix");
					})
					.onChange(async (value) => {
						const parsed = parseFloat(value);
						this.plugin.settings.monthlyLimitDollars =
							isNaN(parsed) || parsed < 0 ? 0 : parsed;
						await this.plugin.saveSettings();
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
