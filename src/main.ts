import { Notice, Plugin } from "obsidian";
import type { ClaudeChatView } from "./chat-view";

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
	"claude-sonnet-4-6": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
	"claude-haiku-4-5":  { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
};
import type {
	VaultPensieveSettings} from "./settings";
import {
	VaultPensieveSettingTab,
	DEFAULT_SETTINGS,
} from "./settings";
import type { AIClient } from "./claude-client";
import { ClaudeClient } from "./claude-client";
import { OllamaClient } from "./ollama-client";
import { ClaudeChatView, CHAT_VIEW_TYPE } from "./chat-view";
import { VaultInstructions } from "./vault-instructions";
import { continueWriting } from "./commands/continue-writing";
import { summarizeNote } from "./commands/summarize-note";
import { improveRewrite } from "./commands/improve-rewrite";

export interface SavedChat {
	id: string;
	title: string;
	updatedAt: number; // ms timestamp
	displayMessages: Array<{ role: "user" | "assistant"; content: string; outputTokens?: number }>;
	apiMessages: unknown[]; // MessageParam[] — plain JSON, cast on load
}

export default class VaultPensievePlugin extends Plugin {
	settings: VaultPensieveSettings = DEFAULT_SETTINGS;
	chats: SavedChat[] = [];
	private client: AIClient | null = null;
	vaultInstructions: VaultInstructions | null = null;
	private structureUpdateTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.vaultInstructions = new VaultInstructions(this.app);

		this.addSettingTab(new VaultPensieveSettingTab(this.app, this));

		// Register chat sidebar view
		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ClaudeChatView(leaf, this));

		// Ribbon icon to open chat
		this.addRibbonIcon("message-square", "Open VaultPensieve", () => {
			void this.activateChatView();
		});

		// Command: open chat
		this.addCommand({
			id: "open-chat",
			name: "Open VaultPensieve",
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

		// Offer to create .instructions.md if none exists
		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				if (!await this.vaultInstructions?.hasInstructions()) {
					new Notice(
						"No .instructions.md found. Create one in settings or manually at vault root.",
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
		const data = (await this.loadData()) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.chats = Array.isArray(data.chats) ? data.chats : [];
	}

	async saveSettings() {
		await this.saveData({ ...this.settings, chats: this.chats });
		this.client = null;
	}

	/** Save data without invalidating the client (e.g. for usage updates). */
	private async saveData_() {
		await this.saveData({ ...this.settings, chats: this.chats });
	}

	saveChat(chat: SavedChat): void {
		const idx = this.chats.findIndex(c => c.id === chat.id);
		if (idx >= 0) {
			this.chats[idx] = chat;
		} else {
			this.chats.unshift(chat); // newest first
		}
		if (this.chats.length > 50) this.chats.length = 50;
		void this.saveData_();
	}

	deleteChat(id: string): void {
		this.chats = this.chats.filter(c => c.id !== id);
		void this.saveData_();
	}

	getChats(): SavedChat[] {
		return this.chats;
	}

	calculateCost(model: string, inputTokens: number, outputTokens: number): number {
		const costs = MODEL_COSTS[model] ?? MODEL_COSTS["claude-sonnet-4-6"];
		return inputTokens * costs.input + outputTokens * costs.output;
	}

	async recordUsage(inputTokens: number, outputTokens: number): Promise<void> {
		// Local Ollama models have no cost — skip tracking
		if (this.settings.provider === "ollama") return;

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
		await this.saveData_();

		// Push update to the open chat view
		this.refreshChatViewUsage();
	}

	isOverLimit(): boolean {
		if (this.settings.provider === "ollama") return false;
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

	getClient(): AIClient {
		if (!this.client) {
			if (this.settings.provider === "ollama") {
				this.client = new OllamaClient(
					this.settings.ollamaBaseUrl,
					this.settings.ollamaModel,
					this.settings.ollamaToolMode
				);
			} else {
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
		}
		return this.client;
	}

	async buildSystemPrompt(): Promise<string> {
		const basePrompt = this.settings.provider === "ollama"
			? `You are a helpful AI assistant integrated into Obsidian. You help the user with writing, organizing, and managing their notes.

You have access to vault tools. You MUST use them for any file operation — never write note content in your reply when a tool should be used instead.

Rules:
- To create a note: call create_note. Do NOT write the note content as text in your response.
- To edit or append to a note: call update_note. Do NOT describe the changes — make them.
- To answer questions about vault content: call read_note or search_notes first.
- To find files: call list_files or get_vault_structure.
- Only respond with text for conversation, explanations, or when no tool is needed.`
			: "You are Claude, an AI assistant integrated into Obsidian. You help the user with writing, organizing, and managing their notes. You have access to vault tools to read and modify files when asked.";
		const parts: string[] = [basePrompt];

		// Load .instructions.md instructions
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
