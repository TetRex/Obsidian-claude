import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudeAssistantPlugin from "./main";

export interface ClaudeAssistantSettings {
	apiKey: string;
	model: string;
	customSystemPrompt: string;
}

export const DEFAULT_SETTINGS: ClaudeAssistantSettings = {
	apiKey: "",
	model: "claude-sonnet-4-6",
	customSystemPrompt: "",
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
