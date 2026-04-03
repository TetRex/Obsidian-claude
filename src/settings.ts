import type { App} from "obsidian";
import { Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { shell } from "electron";
import type VaultPensievePlugin from "./main";

export type AIProvider = "anthropic" | "ollama";
export type OllamaToolMode = "native" | "prompt";

export interface VaultPensieveSettings {
	provider: AIProvider;
	apiKey: string;
	model: string;
	ollamaBaseUrl: string;
	ollamaModel: string;
	ollamaToolMode: OllamaToolMode;
	customSystemPrompt: string;
	monthlyLimitDollars: number; // 0 = no limit (Anthropic only)
	usageMonth: string;          // "2026-03"
	usageDollars: number;        // accumulated spend this month
}

export const DEFAULT_SETTINGS: VaultPensieveSettings = {
	provider: "anthropic",
	apiKey: "",
	model: "claude-sonnet-4-6",
	ollamaBaseUrl: "http://localhost:11434",
	ollamaModel: "llama3.2",
	ollamaToolMode: "prompt",
	customSystemPrompt: "",
	monthlyLimitDollars: 0,
	usageMonth: "",
	usageDollars: 0,
};

const AVAILABLE_MODELS = [
	{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
	{ value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const RECOMMENDED_OLLAMA_MODELS = [
	{ name: "qwen2.5:7b",   size: "~4.7 GB", desc: "Best tool calling at 7B" },
	{ name: "qwen2.5:3b",   size: "~2 GB",   desc: "Smallest with reliable tool calling" },
	{ name: "llama3.2:3b",  size: "~2 GB",   desc: "Meta's small model, good instructions" },
	{ name: "llama3.1:8b",  size: "~4.7 GB", desc: "Well-tested, reliable tool use" },
	{ name: "gemma3:4b",    size: "~3.3 GB", desc: "Google's latest, good quality for the size" },
	{ name: "phi4-mini",    size: "~2.5 GB", desc: "Microsoft's small model, strong reasoning" },
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

	private async pullOllamaModel(
		modelName: string,
		onProgress: (status: string, pct: number | null) => void
	): Promise<void> {
		let response: Response;
		try {
			response = await fetch(`${this.plugin.settings.ollamaBaseUrl}/api/pull`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: modelName, stream: true }),
			});
		} catch {
			throw new Error(`Cannot connect to Ollama at ${this.plugin.settings.ollamaBaseUrl}.`);
		}
		if (!response.ok) {
			throw new Error(`Ollama returned ${response.status} ${response.statusText}`);
		}

		const reader = response.body?.getReader();
		if (!reader) throw new Error("No response body");

		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					let data: { status?: string; total?: number; completed?: number; error?: string };
					try { data = JSON.parse(line); } catch { continue; }
					if (data.error) throw new Error(data.error);
					const pct = (data.total && data.completed != null)
						? Math.round((data.completed / data.total) * 100)
						: null;
					onProgress(data.status ?? "", pct);
				}
			}
		} finally {
			reader.releaseLock();
		}
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

	private async renderAsync(): Promise<void> {
		const isOllama = this.plugin.settings.provider === "ollama";

		// Fetch async data in parallel before rendering
		const [instructionExists, ollamaModels] = await Promise.all([
			this.app.vault.adapter.exists(".instructions.md"),
			isOllama ? this.fetchOllamaModels() : Promise.resolve([] as string[]),
		]);

		// Clear after the async work so concurrent calls don't produce duplicate settings
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Vault instructions (.instructions.md and .structure.md)")
			.setDesc(
				instructionExists
					? "Instructions file exists at vault root. Open it to edit your AI instructions."
					: "No .instructions.md found. Create one with a starter template to customise how Claude behaves."
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
						new Notice(".instructions.md and .structure.md already exists.");
						}
						this.display();
					});
				}
			});

		containerEl.createEl("hr");

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

			new Setting(containerEl)
				.setName("Get Ollama")
				.setDesc("Ollama runs AI models locally on your machine. Download and install it, then restart Obsidian.")
				.addButton(btn => {
					let url = "https://ollama.com/download";
					let label = "Download Ollama";
					if (Platform.isMacOS) {
						url = "https://ollama.com/download/Ollama-darwin.zip";
						label = "Download for macOS";
					} else if (Platform.isWin) {
						url = "https://ollama.com/download/OllamaSetup.exe";
						label = "Download for Windows";
					} else {
						label = "Download for Linux";
					}
					btn.setButtonText(label).onClick(() => {
						void shell.openExternal(url);
					});
				});

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
							.setPlaceholder("llama3.2")
							.setValue(this.plugin.settings.ollamaModel)
							.then((t) => t.inputEl.addClass("claude-setting-input-full"))
							.onChange(async (value) => {
								this.plugin.settings.ollamaModel = value.trim() || "llama3.2";
								await this.plugin.saveSettings();
							})
					);
			}

			new Setting(containerEl)
				.setName("Tool calling mode")
				.setDesc(
					"\"Prompt-based\" works with all models by describing tools in the prompt. " +
					"\"Native\" uses the API's built-in tool calling, which only some models support."
				)
				.addDropdown((dropdown) => {
					dropdown.addOption("prompt", "Prompt-based (recommended)");
					dropdown.addOption("native", "Native API tool calling");
					dropdown
						.setValue(this.plugin.settings.ollamaToolMode)
						.onChange(async (value) => {
							this.plugin.settings.ollamaToolMode = value as "native" | "prompt";
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName("Recommended models")
				.setDesc("Models with reliable tool calling for vault operations. Requires Ollama to be running.");

			const modelList = containerEl.createDiv({ cls: "claude-model-list" });

			for (const rec of RECOMMENDED_OLLAMA_MODELS) {
				const installed = ollamaModels.includes(rec.name);

				const item = modelList.createDiv({ cls: "claude-model-item" });

				const info = item.createDiv({ cls: "claude-model-info" });
				info.createSpan({ cls: "claude-model-name", text: rec.name });
				const meta = info.createDiv({ cls: "claude-model-meta" });
				meta.createSpan({ cls: "claude-model-size", text: rec.size });
				meta.createSpan({ cls: "claude-model-desc", text: rec.desc });

				const btnWrap = item.createDiv({ cls: "claude-model-btn-wrap" });
				const btn = btnWrap.createEl("button", {
					text: installed ? "Installed" : "Pull",
					cls: `claude-model-btn${installed ? " installed" : ""}`,
				});
				const progressEl = btnWrap.createDiv({ cls: "claude-model-progress hidden" });

				if (installed) {
					btn.disabled = true;
				} else {
					btn.addEventListener("click", () => void (async () => {
						btn.disabled = true;
						btn.textContent = "Pulling…";
						progressEl.removeClass("hidden");
						try {
							await this.pullOllamaModel(rec.name, (status, pct) => {
								btn.textContent = pct !== null ? `${pct}%` : "Pulling…";
								progressEl.textContent = status;
							});
							btn.textContent = "Installed";
							btn.addClass("installed");
							progressEl.addClass("hidden");
							new Notice(`${rec.name} pulled successfully.`);
							this.display();
						} catch (e) {
							const msg = e instanceof Error ? e.message : "Pull failed";
							new Notice(`Failed to pull ${rec.name}: ${msg}`);
							btn.disabled = false;
							btn.textContent = "Retry";
							progressEl.addClass("hidden");
						}
					})());
				}
			}
		}

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
