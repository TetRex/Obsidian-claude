import type { App, WorkspaceLeaf} from "obsidian";
import { ItemView, Notice, Platform, MarkdownRenderer, setIcon } from "obsidian";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type VaultPensievePlugin from "./main";
import type { SavedChat } from "./main";
import { VAULT_TOOLS, createToolExecutor } from "./vault-tools";

export const CHAT_VIEW_TYPE = "claude-chat-view";

// Obsidian exposes a `setting` object on App that is not in its public type definitions.
interface AppWithSetting extends App {
	setting: {
		open(): void;
		openTabById(id: string): void;
	};
}

const MODELS = [
	{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	outputTokens?: number;
}

export class ClaudeChatView extends ItemView {
	private plugin: VaultPensievePlugin;
	private displayMessages: ChatMessage[] = [];
	private apiMessages: MessageParam[] = [];
	private messagesContainer: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private attachBtn: HTMLButtonElement | null = null;
	private modelSelect: HTMLSelectElement | null = null;
	private attachNote = false;
	private attachedNoteName: string | null = null;
	private attachedNoteChip: HTMLElement | null = null;
	private isStreaming = false;
	private usageBarFill: HTMLElement | null = null;
	private usageLabel: HTMLElement | null = null;
	private promptHistory: string[] = [];
	private historyIndex = -1;
	private historyDraft = "";
	private currentChatId: string | null = null;
	private historyPanel: HTMLElement | null = null;
	private showingHistory = false;

	constructor(leaf: WorkspaceLeaf, plugin: VaultPensievePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return CHAT_VIEW_TYPE; }
	getDisplayText(): string { return "VaultPensieve"; }
	getIcon(): string { return "message-square"; }

	onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("claude-chat-container");

		// ── Header ──────────────────────────────────────────────
		const header = container.createDiv({ cls: "claude-chat-header" });
		const titleRow = header.createDiv({ cls: "claude-chat-title-row" });
		titleRow.createSpan({ cls: "claude-chat-title", text: "VaultPensieve" });

		const headerActions = titleRow.createDiv({ cls: "claude-chat-header-actions" });

		// Model selector
		this.modelSelect = headerActions.createEl("select", { cls: "claude-model-select" });
		if (this.plugin.settings.provider === "ollama") {
			const opt = this.modelSelect.createEl("option", {
				text: this.plugin.settings.ollamaModel,
				value: this.plugin.settings.ollamaModel,
			});
			opt.selected = true;
			this.modelSelect.disabled = true;
		} else {
			for (const m of MODELS) {
				const opt = this.modelSelect.createEl("option", { text: m.label, value: m.value });
				if (m.value === this.plugin.settings.model) opt.selected = true;
			}
		}
		this.modelSelect.addEventListener("change", () => void (async () => {
			if (!this.modelSelect || this.plugin.settings.provider === "ollama") return;
			const modelValue = this.modelSelect.value;
			this.plugin.settings.model = modelValue;
			await this.plugin.saveSettings();
			const label = MODELS.find(m => m.value === modelValue)?.label;
			new Notice(`Switched to ${label}`);
		})());

		// History button
		const historyBtn = headerActions.createEl("button", {
			cls: "claude-icon-btn",
			attr: { title: "Chat history" },
		});
		setIcon(historyBtn, "clock");
		historyBtn.addEventListener("click", () => {
			this.showingHistory ? this.hideHistory() : this.showHistory();
		});

		// New chat button
		const newChatBtn = headerActions.createEl("button", {
			cls: "claude-icon-btn",
			attr: { title: "New chat" },
		});
		setIcon(newChatBtn, "plus");
		newChatBtn.addEventListener("click", () => this.newChat());

		// Settings button
		const settingsBtn = headerActions.createEl("button", {
			cls: "claude-icon-btn",
			attr: { title: "VaultPensieve settings" },
		});
		setIcon(settingsBtn, "settings");
		settingsBtn.addEventListener("click", () => {
			(this.app as AppWithSetting).setting.open();
			(this.app as AppWithSetting).setting.openTabById("vault-pensieve");
		});

		// ── Usage bar (Anthropic only) ───────────────────────────
		const usageRow = header.createDiv({ cls: "claude-usage-row" });
		if (this.plugin.settings.provider === "ollama") {
			usageRow.addClass("hidden");
		} else {
			this.usageLabel = usageRow.createSpan({ cls: "claude-usage-label" });
			const usageTrack = usageRow.createDiv({ cls: "claude-usage-track" });
			this.usageBarFill = usageTrack.createDiv({ cls: "claude-usage-fill" });
			this.updateUsageDisplay();
		}

		// ── History panel ─────────────────────────────────────────
		this.historyPanel = container.createDiv({ cls: "claude-history-panel hidden" });
		const histPanelHeader = this.historyPanel.createDiv({ cls: "claude-history-header" });
		histPanelHeader.createSpan({ cls: "claude-history-title", text: "Chats" });
		const closeHistBtn = histPanelHeader.createEl("button", { cls: "claude-icon-btn", attr: { title: "Close" } });
		setIcon(closeHistBtn, "x");
		closeHistBtn.addEventListener("click", () => this.hideHistory());
		this.historyPanel.createDiv({ cls: "claude-history-list" });

		// ── Messages ─────────────────────────────────────────────
		this.messagesContainer = container.createDiv({ cls: "claude-chat-messages" });
		this.renderMessages();

		// ── Input area ───────────────────────────────────────────
		const inputArea = container.createDiv({ cls: "claude-chat-input-area" });

		// Note chip row — shown above input row when a note is attached
		const chipRow = inputArea.createDiv({ cls: "claude-input-chip-row" });
		this.attachedNoteChip = chipRow.createDiv({ cls: "claude-note-chip hidden" });

		// Unified input row: [attach] [textarea] [send]
		const inputRow = inputArea.createDiv({ cls: "claude-input-row" });

		this.attachBtn = inputRow.createEl("button", {
			cls: "claude-attach-btn",
			attr: { title: "Attach current note as context" },
		});
		setIcon(this.attachBtn, "paperclip");
		this.attachBtn.addEventListener("click", () => {
			if (this.attachNote) {
				this.clearAttach();
			} else {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("No note is currently open.");
					return;
				}
				this.attachNote = true;
				this.attachedNoteName = activeFile.basename;
				this.attachBtn?.toggleClass("active", true);
				this.renderAttachChip();
			}
		});

		this.inputEl = inputRow.createEl("textarea", {
			cls: "claude-chat-textarea",
			attr: {
				placeholder: Platform.isMobile ? "Message AI…" : "Message AI…",
				rows: "1",
			},
		});
		this.inputEl.addEventListener("input", () => this.autoResizeTextarea());
		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			// On mobile, Enter adds a newline — use the send button instead
			if (!Platform.isMobile && e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.sendMessage();
				return;
			}

			// Arrow up/down — navigate prompt history
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				if (!this.inputEl || this.promptHistory.length === 0) return;

				// Only intercept when cursor is on the first/last line
				const atFirstLine = this.inputEl.selectionStart <= this.inputEl.value.indexOf("\n") || !this.inputEl.value.includes("\n");
				const atLastLine = this.inputEl.selectionStart >= this.inputEl.value.lastIndexOf("\n") + 1;

				if (e.key === "ArrowUp" && !atFirstLine) return;
				if (e.key === "ArrowDown" && !atLastLine) return;

				e.preventDefault();

				if (e.key === "ArrowUp") {
					if (this.historyIndex === -1) {
						// Save current draft before navigating
						this.historyDraft = this.inputEl.value;
					}
					const next = this.historyIndex + 1;
					if (next < this.promptHistory.length) {
						this.historyIndex = next;
						this.inputEl.value = this.promptHistory[this.promptHistory.length - 1 - this.historyIndex];
					}
				} else {
					if (this.historyIndex <= 0) {
						this.historyIndex = -1;
						this.inputEl.value = this.historyDraft;
					} else {
						this.historyIndex--;
						this.inputEl.value = this.promptHistory[this.promptHistory.length - 1 - this.historyIndex];
					}
				}

				this.autoResizeTextarea();
				// Move cursor to end
				this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
			}
		});

		this.sendBtn = inputRow.createEl("button", {
			cls: "claude-send-btn mod-cta",
			attr: { title: "Send" },
		});
		setIcon(this.sendBtn, "send");
		this.sendBtn.addEventListener("click", () => void this.sendMessage());
	}

	onClose() {}

	private saveCurrentChat() {
		if (this.displayMessages.length === 0) return;
		if (!this.currentChatId) {
			this.currentChatId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		}
		const firstUser = this.displayMessages.find(m => m.role === "user");
		const title = (firstUser?.content ?? "Chat")
			.replace(/\n/g, " ")
			.slice(0, 60)
			.trimEnd();
		this.plugin.saveChat({
			id: this.currentChatId,
			title,
			updatedAt: Date.now(),
			displayMessages: this.displayMessages.map(m => ({ ...m })),
			apiMessages: [...this.apiMessages],
		});
	}

	private newChat() {
		this.saveCurrentChat();
		this.currentChatId = null;
		this.displayMessages = [];
		this.apiMessages = [];
		this.hideHistory();
		this.renderMessages();
	}

	private loadChat(chat: SavedChat) {
		this.currentChatId = chat.id;
		this.displayMessages = chat.displayMessages.map(m => ({ ...m }));
		this.apiMessages = chat.apiMessages as MessageParam[];
		this.hideHistory();
		this.renderMessages();
		this.scrollToBottom();
	}

	private showHistory() {
		this.showingHistory = true;
		this.renderHistoryList();
		this.historyPanel?.removeClass("hidden");
		this.messagesContainer?.addClass("hidden");
	}

	private hideHistory() {
		this.showingHistory = false;
		this.historyPanel?.addClass("hidden");
		this.messagesContainer?.removeClass("hidden");
	}

	private renderHistoryList() {
		if (!this.historyPanel) return;
		const list = this.historyPanel.querySelector(".claude-history-list") as HTMLElement | null;
		if (!list) return;
		list.empty();

		const chats = this.plugin.getChats();
		if (chats.length === 0) {
			list.createDiv({ cls: "claude-history-empty", text: "No saved chats yet." });
			return;
		}

		for (const chat of chats) {
			const item = list.createDiv({ cls: "claude-history-item" });
			if (chat.id === this.currentChatId) item.addClass("active");

			const main = item.createDiv({ cls: "claude-history-item-main" });
			main.createDiv({ cls: "claude-history-item-title", text: chat.title });
			main.createDiv({ cls: "claude-history-item-date", text: this.formatDate(chat.updatedAt) });
			main.addEventListener("click", () => this.loadChat(chat));

			const del = item.createEl("button", { cls: "claude-icon-btn", attr: { title: "Delete chat" } });
			setIcon(del, "x");
			del.addEventListener("click", (e) => {
				e.stopPropagation();
				this.plugin.deleteChat(chat.id);
				if (this.currentChatId === chat.id) {
					this.currentChatId = null;
					this.displayMessages = [];
					this.apiMessages = [];
				}
				this.renderHistoryList();
			});
		}
	}

	private formatDate(ts: number): string {
		const diff = Date.now() - ts;
		const min = Math.floor(diff / 60_000);
		if (min < 1) return "just now";
		if (min < 60) return `${min}m ago`;
		const h = Math.floor(min / 60);
		if (h < 24) return `${h}h ago`;
		const d = Math.floor(h / 24);
		if (d < 7) return `${d}d ago`;
		return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}

	private autoResizeTextarea() {
		if (!this.inputEl) return;
		this.inputEl.setCssProps({ "--claude-textarea-height": "auto" });
		this.inputEl.setCssProps({ "--claude-textarea-height": Math.min(this.inputEl.scrollHeight, 160) + "px" });
	}

	private async sendMessage() {
		if (this.isStreaming || !this.inputEl) return;
		const text = this.inputEl.value.trim();
		if (!text) return;

		if (this.plugin.isOverLimit()) {
			new Notice(
				`Monthly spending limit of $${this.plugin.settings.monthlyLimitDollars.toFixed(2)} reached. Adjust the limit in settings.`
			);
			return;
		}

		this.promptHistory.push(text);
		this.historyIndex = -1;
		this.historyDraft = "";

		this.inputEl.value = "";
		this.autoResizeTextarea();
		this.setStreaming(true);

		let userContent = text;
		if (this.attachNote) {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
				const raw = await this.app.vault.read(activeFile);
				const MAX_NOTE_CHARS = 8000;
				const noteContent = raw.length > MAX_NOTE_CHARS
					? raw.slice(0, MAX_NOTE_CHARS) + "\n\n[…note truncated for token efficiency]"
					: raw;
				userContent = `[Attached note: ${activeFile.path}]\n\n${noteContent}\n\n---\n\n${text}`;
			}
			this.clearAttach();
		}

		this.displayMessages.push({ role: "user", content: text });

		// Trim history to last 20 messages to cap input tokens
		const MAX_HISTORY = 20;
		if (this.apiMessages.length >= MAX_HISTORY) {
			this.apiMessages = this.apiMessages.slice(-MAX_HISTORY);
			// Ensure the first message is from the user (API requirement)
			while (this.apiMessages.length > 0 && this.apiMessages[0].role !== "user") {
				this.apiMessages = this.apiMessages.slice(1);
			}
		}

		this.apiMessages.push({ role: "user", content: userContent });

		const assistantMsg: ChatMessage = { role: "assistant", content: "" };
		this.displayMessages.push(assistantMsg);
		this.renderMessages();
		this.scrollToBottom();

		try {
			const client = this.plugin.getClient();
			const systemPrompt = await this.plugin.buildSystemPrompt();
			const toolExecutor = createToolExecutor(this.app);

			const newMessages = await client.streamMessage(
				systemPrompt,
				this.apiMessages,
				{
					onChunk: (chunk: string) => {
						assistantMsg.content += chunk;
						this.renderMessages();
						this.scrollToBottom();
					},
					onComplete: () => {
						this.renderMessages();
						this.scrollToBottom();
					},
					onError: (error: Error) => {
						new Notice(`Claude error: ${error.message}`);
					},
					onUsage: (inputTokens: number, outputTokens: number) => {
						assistantMsg.outputTokens = outputTokens;
						void this.plugin.recordUsage(inputTokens, outputTokens);
					},
				},
				VAULT_TOOLS,
				async (name: string, input: Record<string, unknown>) => {
					return toolExecutor(name, input);
				}
			);

			for (const msg of newMessages) {
				this.apiMessages.push(msg);
			}
		} catch (e) {
			if (assistantMsg.content === "") {
				assistantMsg.content = e instanceof Error ? e.message : "Something went wrong";
			}
			this.renderMessages();
		} finally {
			this.setStreaming(false);
			this.saveCurrentChat();
		}
	}

	private setStreaming(streaming: boolean) {
		this.isStreaming = streaming;
		if (this.sendBtn) this.sendBtn.disabled = streaming;
		if (this.inputEl) this.inputEl.disabled = streaming;
	}

	private renderMessages() {
		if (!this.messagesContainer) return;
		this.messagesContainer.empty();

		if (this.displayMessages.length === 0) {
			const empty = this.messagesContainer.createDiv({ cls: "claude-chat-empty" });
			empty.createDiv({ cls: "claude-chat-empty-icon", text: "✦" });
			empty.createDiv({ cls: "claude-chat-empty-text", text: "Ask anything about your vault" });
			return;
		}

		for (const msg of this.displayMessages) {
			const row = this.messagesContainer.createDiv({ cls: `claude-msg-row ${msg.role}` });
			const bubble = row.createDiv({ cls: "claude-msg-bubble" });

			if (msg.role === "assistant") {
				void MarkdownRenderer.render(this.app, msg.content || "…", bubble, "", this);
				if (msg.outputTokens !== undefined) {
					bubble.createDiv({
						cls: "claude-msg-tokens",
						text: `${msg.outputTokens} tokens`,
					});
				}
			} else {
				bubble.textContent = msg.content;
			}
		}
	}

	updateUsageDisplay() {
		if (!this.usageLabel || !this.usageBarFill) return;
		const { dollars, limitDollars } = this.plugin.getUsageInfo();

		if (limitDollars > 0) {
			const pct = Math.min(dollars / limitDollars, 1) * 100;
			this.usageLabel.textContent = `$${dollars.toFixed(3)} / $${limitDollars.toFixed(2)}`;
			this.usageBarFill.setCssProps({ "--claude-usage-pct": `${pct}%` });
			this.usageBarFill.toggleClass("over-limit", dollars >= limitDollars);
			this.usageBarFill.closest(".claude-usage-track")?.removeClass("hidden");
		} else {
			this.usageLabel.textContent = dollars > 0 ? `$${dollars.toFixed(3)} this month` : "";
			this.usageBarFill.setCssProps({ "--claude-usage-pct": "0%" });
			this.usageBarFill.closest(".claude-usage-track")?.addClass("hidden");
		}
	}

	private renderAttachChip() {
		if (!this.attachedNoteChip) return;
		this.attachedNoteChip.empty();
		this.attachedNoteChip.removeClass("hidden");
		this.attachedNoteChip.createSpan({
			cls: "claude-note-chip-name",
			text: this.attachedNoteName ?? "",
		});
		const dismiss = this.attachedNoteChip.createSpan({ cls: "claude-note-chip-dismiss", text: "×" });
		dismiss.addEventListener("click", () => this.clearAttach());
	}

	private clearAttach() {
		this.attachNote = false;
		this.attachedNoteName = null;
		this.attachBtn?.toggleClass("active", false);
		if (this.attachedNoteChip) {
			this.attachedNoteChip.empty();
			this.attachedNoteChip.addClass("hidden");
		}
	}

	private scrollToBottom() {
		if (this.messagesContainer) {
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}
	}
}
