import type { App} from "obsidian";
import { Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultPensievePlugin from "./main";

export type AIProvider = "anthropic" | "ollama";

export interface VaultPensieveSettings {
	provider: AIProvider;
	apiKey: string;
	model: string;
	ollamaBaseUrl: string;
	ollamaModel: string;
	customSystemPrompt: string;
	useInstructionFiles: boolean;
	monthlyLimitDollars: number; // 0 = no limit (Anthropic only)
	usageMonth: string;          // "2026-03"
	usageDollars: number;        // accumulated spend this month
}

export const DEFAULT_SETTINGS: VaultPensieveSettings = {
	provider: "anthropic",
	apiKey: "",
	model: "claude-sonnet-4-6",
	ollamaBaseUrl: "http://localhost:11434",
	ollamaModel: "gemma4",
	customSystemPrompt: "",
	useInstructionFiles: false,
	monthlyLimitDollars: 0,
	usageMonth: "",
	usageDollars: 0,
};

const AVAILABLE_MODELS = [
	{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
	{ value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export class VaultPensieveSettingTab extends PluginSettingTab {
	plugin: VaultPensievePlugin;

	constructor(app: App, plugin: VaultPensievePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		void this.renderAsync();
	}

	private async fetchOllamaModels(): Promise<string[]> {
		try {
			const response = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/tags`);
			if (!response.ok) return [];
			const data = await response.json() as { models?: Array<{ name: string }> };
			return (data.models ?? []).map(m => m.name);
		} catch {
			return [];
		}
	}

	private async assertOllamaToolCallingSupport(): Promise<string[]> {
		let response: Response;
		try {
			response = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/show`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.plugin.settings.ollamaModel }),
			});
		} catch {
			throw new Error(
				`Cannot connect to Ollama at ${this.plugin.settings.ollamaBaseUrl}. Make sure Ollama is running.`
			);
		}

		if (!response.ok) {
			throw new Error(
				`Connected to Ollama, but could not inspect model "${this.plugin.settings.ollamaModel}" (${response.status} ${response.statusText}).`
			);
		}

		const data = await response.json() as { capabilities?: unknown };
		const capabilities = Array.isArray(data.capabilities)
			? data.capabilities.filter((value): value is string => typeof value === "string")
			: [];

		if (capabilities.length === 0) {
			throw new Error(
				`Connected to Ollama, but model "${this.plugin.settings.ollamaModel}" did not return any advertised capabilities.`
			);
		}

		const normalizedCapabilities = capabilities.map(c => c.toLowerCase());
		const supportsTools = normalizedCapabilities.some(capability =>
			capability === "tools" ||
			capability === "tool-calling" ||
			capability === "tool_calling" ||
			capability === "function-calling" ||
			capability === "function_calling"
		);

		if (!supportsTools) {
			throw new Error(
				`Connected to Ollama, but model "${this.plugin.settings.ollamaModel}" does not advertise tool calling in /api/show. Capabilities: ${capabilities.join(", ")}.`
			);
		}

		return capabilities;
	}

	private async renderAsync(): Promise<void> {
		const isOllama = this.plugin.settings.provider === "ollama";
		const usesInstructionFiles = this.plugin.settings.useInstructionFiles;

		// Fetch async data in parallel before rendering
		const [instructionExists, ollamaModels] = await Promise.all([
			usesInstructionFiles
				? this.app.vault.adapter.exists(".instructions.md")
				: Promise.resolve(false),
			isOllama ? this.fetchOllamaModels() : Promise.resolve([] as string[]),
		]);

		// Clear after the async work so concurrent calls don't produce duplicate settings
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("AI provider")
			.setDesc("Use Anthropic's Claude API or a local Ollama instance.")
			.addDropdown((dropdown) => {
				dropdown.addOption("anthropic", "Anthropic (Claude)");
				dropdown.addOption("ollama", "Ollama (local)");
				dropdown
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value as "anthropic" | "ollama";
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (!isOllama) {
			new Setting(containerEl)
				.setName("API key")
				.setDesc("Your api key stored locally in plugin data.")
				.addText((text) =>
					text
						.setPlaceholder("")
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
				.setDesc("Which Claude model to use.")
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
		} else {

			if (ollamaModels.length > 0) {
				new Setting(containerEl)
					.setName("Ollama model")
					.setDesc("Select from models installed in Ollama.")
					.addDropdown((dropdown) => {
						for (const m of ollamaModels) {
							dropdown.addOption(m, m);
						}
						// Keep saved model selectable even if it disappeared from the list
						if (!ollamaModels.includes(this.plugin.settings.ollamaModel)) {
							dropdown.addOption(
								this.plugin.settings.ollamaModel,
								this.plugin.settings.ollamaModel
							);
						}
						dropdown
							.setValue(this.plugin.settings.ollamaModel)
							.onChange(async (value) => {
								this.plugin.settings.ollamaModel = value;
								await this.plugin.saveSettings();
							});
					});
			} else {
				new Setting(containerEl)
					.setName("Ollama model")
					.setDesc("Could not fetch installed models — enter a name manually, or check the URL and click \"Refresh models\".")
					.addText((text) =>
						text
							.setPlaceholder("gemma4")
							.setValue(this.plugin.settings.ollamaModel)
							.then((t) => t.inputEl.addClass("claude-setting-input-full"))
							.onChange(async (value) => {
								this.plugin.settings.ollamaModel = value.trim() || "gemma4";
								await this.plugin.saveSettings();
							})
					);
			}

		}

		new Setting(containerEl)
			.setName("Custom system prompt")
			.setDesc(
				"Primary place for your assistant instructions. Leave empty for defaults."
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
			.setName("Use vault instruction files")
			.setDesc(
				"Optional advanced feature. Load .instructions.md files from the vault instead of relying on settings only."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(usesInstructionFiles)
					.onChange(async (value) => {
						this.plugin.settings.useInstructionFiles = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (usesInstructionFiles) {
			new Setting(containerEl)
				.setName("Vault instruction files")
				.setDesc(
					instructionExists
						? "The root .instructions.md file is enabled and will be added to the system prompt."
						: "No .instructions.md found. Create one if you want file-based instructions and automatic .structure.md maintenance."
				)
				.addButton((btn) => {
					if (instructionExists) {
						btn.setButtonText("Delete .instructions.md").onClick(async () => {
							await this.app.vault.adapter.remove(".instructions.md");
							new Notice(".instructions.md deleted.");
							this.display();
						});
					} else {
						btn.setButtonText("Create .instructions.md").setCta().onClick(async () => {
							const created = await this.plugin.vaultInstructions?.createStarterTemplate();
							if (created) {
								new Notice(".instructions.md and .structure.md created at vault root.");
							} else {
								new Notice(".instructions.md and .structure.md already exist.");
							}
							this.display();
						});
					}
				});
		}

		if (!isOllama) {
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
		}

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc(
				isOllama
					? "Check that Ollama is reachable at the configured URL."
					: "Send a test message to verify your API key works."
			)
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					if (!isOllama && !this.plugin.settings.apiKey) {
						new Notice("Please enter an API key first.");
						return;
					}
					button.setButtonText("Testing...");
					button.setDisabled(true);
					try {
						const client = this.plugin.getClient();
						await client.testConnection();
						if (isOllama) {
							const capabilities = await this.assertOllamaToolCallingSupport();
							new Notice(
								`Connection successful! "${this.plugin.settings.ollamaModel}" supports tool calling (${capabilities.join(", ")}).`
							);
						} else {
							new Notice("Connection successful!");
						}
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
