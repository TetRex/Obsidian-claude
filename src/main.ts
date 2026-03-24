import { Notice, Plugin } from "obsidian";
import type { ClaudeChatView } from "./chat-view";

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
	"claude-sonnet-4-6": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
	"claude-haiku-4-5":  { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
};
import type {
	ClaudeAssistantSettings} from "./settings";
import {
	ClaudeSettingTab,
	DEFAULT_SETTINGS,
} from "./settings";
import { ClaudeClient } from "./claude-client";
import { ClaudeChatView, CHAT_VIEW_TYPE } from "./chat-view";
import { VaultInstructions } from "./vault-instructions";
import { continueWriting } from "./commands/continue-writing";
import { summarizeNote } from "./commands/summarize-note";
import { improveRewrite } from "./commands/improve-rewrite";

export default class ClaudeAssistantPlugin extends Plugin {
	settings: ClaudeAssistantSettings = DEFAULT_SETTINGS;
	private client: ClaudeClient | null = null;
	vaultInstructions: VaultInstructions | null = null;
	private structureUpdateTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.vaultInstructions = new VaultInstructions(this.app);

		this.addSettingTab(new ClaudeSettingTab(this.app, this));

		// Register chat sidebar view
		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ClaudeChatView(leaf, this));

		// Ribbon icon to open chat
		this.addRibbonIcon("message-square", "Open claude chat", () => {
			void this.activateChatView();
		});

		// Command: open chat
		this.addCommand({
			id: "open-chat",
			name: "Open claude chat",
			callback: () => this.activateChatView(),
		});

		// Command: continue writing
		this.addCommand({
			id: "continue-writing",
			name: "Continue writing",
			editorCallback: (editor) => continueWriting(this, editor),
		});

		// Command: summarize note
		this.addCommand({
			id: "summarize-note",
			name: "Summarize note",
			editorCallback: (editor) => summarizeNote(this, editor),
		});

		// Command: improve/rewrite selection
		this.addCommand({
			id: "improve-rewrite",
			name: "Improve/rewrite selection",
			editorCallback: (editor) => improveRewrite(this, editor),
		});

		// Auto-update .structure.md on vault changes
		const scheduleStructureUpdate = () => {
			if (this.structureUpdateTimer !== null) window.clearTimeout(this.structureUpdateTimer);
			this.structureUpdateTimer = window.setTimeout(() => {
				this.structureUpdateTimer = null;
				void this.vaultInstructions?.updateStructureFile();
			}, 500);
		};
		this.registerEvent(this.app.vault.on("create", (f) => { if (!f.path.startsWith(".")) scheduleStructureUpdate(); }));
		this.registerEvent(this.app.vault.on("delete", (f) => { if (!f.path.startsWith(".")) scheduleStructureUpdate(); }));
		this.registerEvent(this.app.vault.on("rename", (f) => { if (!f.path.startsWith(".")) scheduleStructureUpdate(); }));

		// Offer to create .claude.md if none exists
		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				if (!await this.vaultInstructions?.hasInstructions()) {
					new Notice(
						"No .claude.md found. Create one in settings or manually at vault root.",
						8000
					);
				}
			})();
		});
	}

	onunload() {
		this.client = null;
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.client = null;
	}

	/** Save data without invalidating the client (e.g. for usage updates). */
	private async saveData_(data: unknown) {
		await this.saveData(data);
	}

	calculateCost(model: string, inputTokens: number, outputTokens: number): number {
		const costs = MODEL_COSTS[model] ?? MODEL_COSTS["claude-sonnet-4-6"];
		return inputTokens * costs.input + outputTokens * costs.output;
	}

	async recordUsage(inputTokens: number, outputTokens: number): Promise<void> {
		const currentMonth = new Date().toISOString().slice(0, 7); // "2026-03"

		// Reset counter on new month
		if (this.settings.usageMonth !== currentMonth) {
			this.settings.usageMonth = currentMonth;
			this.settings.usageDollars = 0;
		}

		this.settings.usageDollars += this.calculateCost(
			this.settings.model,
			inputTokens,
			outputTokens
		);
		await this.saveData_(this.settings);

		// Push update to the open chat view
		this.refreshChatViewUsage();
	}

	isOverLimit(): boolean {
		if (!this.settings.monthlyLimitDollars) return false;
		return this.settings.usageDollars >= this.settings.monthlyLimitDollars;
	}

	getUsageInfo() {
		return {
			dollars: this.settings.usageDollars,
			limitDollars: this.settings.monthlyLimitDollars,
		};
	}

	private refreshChatViewUsage() {
		for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
			(leaf.view as ClaudeChatView).updateUsageDisplay();
		}
	}

	getClient(): ClaudeClient {
		if (!this.client) {
			if (!this.settings.apiKey) {
				throw new Error(
					"API key not configured. Please set it in plugin settings."
				);
			}
			this.client = new ClaudeClient(
				this.settings.apiKey,
				this.settings.model
			);
		}
		return this.client;
	}

	async buildSystemPrompt(): Promise<string> {
		const parts: string[] = [
			"You are Claude, an AI assistant integrated into Obsidian. You help the user with writing, organizing, and managing their notes. You have access to vault tools to read and modify files when asked.",
		];

		// Load .claude.md instructions
		if (this.vaultInstructions) {
			const activeFile = this.app.workspace.getActiveFile();
			const instructions = await this.vaultInstructions.getInstructions(
				activeFile?.path
			);
			if (instructions) {
				parts.push("## User Instructions\n\n" + instructions);
			}
		}

		// Custom system prompt from settings
		if (this.settings.customSystemPrompt.trim()) {
			parts.push(
				"## Additional Instructions\n\n" +
					this.settings.customSystemPrompt
			);
		}

		return parts.join("\n\n");
	}

	private async activateChatView() {
		const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
			await this.app.workspace.revealLeaf(leaf);
		}
	}
}
