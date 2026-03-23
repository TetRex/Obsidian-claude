import { ItemView, Notice, WorkspaceLeaf, MarkdownRenderer, setIcon } from "obsidian";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type ClaudeAssistantPlugin from "./main";
import { VAULT_TOOLS, createToolExecutor } from "./vault-tools";

export const CHAT_VIEW_TYPE = "claude-chat-view";

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
	private plugin: ClaudeAssistantPlugin;
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

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeAssistantPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return CHAT_VIEW_TYPE; }
	getDisplayText(): string { return "Claude Chat"; }
	getIcon(): string { return "message-square"; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("claude-chat-container");

		// ── Header ──────────────────────────────────────────────
		const header = container.createDiv({ cls: "claude-chat-header" });
		const titleRow = header.createDiv({ cls: "claude-chat-title-row" });
		titleRow.createSpan({ cls: "claude-chat-title", text: "Claude" });

		const headerActions = titleRow.createDiv({ cls: "claude-chat-header-actions" });

		// Model selector
		this.modelSelect = headerActions.createEl("select", { cls: "claude-model-select" });
		for (const m of MODELS) {
			const opt = this.modelSelect.createEl("option", { text: m.label, value: m.value });
			if (m.value === this.plugin.settings.model) opt.selected = true;
		}
		this.modelSelect.addEventListener("change", async () => {
			if (!this.modelSelect) return;
			this.plugin.settings.model = this.modelSelect.value;
			await this.plugin.saveSettings();
			const label = MODELS.find(m => m.value === this.modelSelect!.value)?.label;
			new Notice(`Switched to ${label}`);
		});

		// Settings button
		const settingsBtn = headerActions.createEl("button", {
			cls: "claude-icon-btn",
			attr: { title: "Claude Assistant settings" },
		});
		setIcon(settingsBtn, "settings");
		settingsBtn.addEventListener("click", () => {
			(this.app as any).setting.open();
			(this.app as any).setting.openTabById("claudesidian");
		});

		// Clear button
		const clearBtn = headerActions.createEl("button", {
			cls: "claude-icon-btn",
			attr: { title: "Clear chat" },
		});
		setIcon(clearBtn, "trash-2");
		clearBtn.addEventListener("click", () => {
			this.displayMessages = [];
			this.apiMessages = [];
			this.renderMessages();
		});

		// ── Usage bar ────────────────────────────────────────────
		const usageRow = header.createDiv({ cls: "claude-usage-row" });
		this.usageLabel = usageRow.createSpan({ cls: "claude-usage-label" });
		const usageTrack = usageRow.createDiv({ cls: "claude-usage-track" });
		this.usageBarFill = usageTrack.createDiv({ cls: "claude-usage-fill" });
		this.updateUsageDisplay();

		// ── Messages ─────────────────────────────────────────────
		this.messagesContainer = container.createDiv({ cls: "claude-chat-messages" });
		this.renderMessages();

		// ── Input area ───────────────────────────────────────────
		const inputArea = container.createDiv({ cls: "claude-chat-input-area" });

		this.inputEl = inputArea.createEl("textarea", {
			cls: "claude-chat-textarea",
			attr: { placeholder: "Message Claude… (Enter to send)", rows: "1" },
		});
		this.inputEl.addEventListener("input", () => this.autoResizeTextarea());
		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		const inputFooter = inputArea.createDiv({ cls: "claude-chat-input-footer" });

		// Left side: attach button + note chip
		const inputFooterLeft = inputFooter.createDiv({ cls: "claude-input-footer-left" });

		// Attach button
		this.attachBtn = inputFooterLeft.createEl("button", {
			cls: "claude-attach-btn",
			attr: { title: "Attach current note as context" },
		});
		setIcon(this.attachBtn, "paperclip");
		this.attachBtn.createSpan({ text: " Attach note" });
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
				this.renderAttachChip(inputFooterLeft);
			}
		});

		// Chip placeholder (rendered dynamically)
		this.attachedNoteChip = inputFooterLeft.createDiv({ cls: "claude-note-chip hidden" });

		// Send button
		this.sendBtn = inputFooter.createEl("button", {
			cls: "claude-send-btn mod-cta",
			attr: { title: "Send (Enter)" },
		});
		setIcon(this.sendBtn, "send");
		this.sendBtn.addEventListener("click", () => this.sendMessage());
	}

	async onClose() {}

	private autoResizeTextarea() {
		if (!this.inputEl) return;
		this.inputEl.style.height = "auto";
		this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + "px";
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

		this.inputEl.value = "";
		this.autoResizeTextarea();
		this.setStreaming(true);

		let userContent = text;
		if (this.attachNote) {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
				const noteContent = await this.app.vault.read(activeFile);
				userContent = `[Attached note: ${activeFile.path}]\n\n${noteContent}\n\n---\n\n${text}`;
			}
			this.clearAttach();
		}

		this.displayMessages.push({ role: "user", content: text });
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
						this.plugin.recordUsage(inputTokens, outputTokens);
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
			empty.createDiv({ cls: "claude-chat-empty-text", text: "Ask Claude anything about your vault" });
			return;
		}

		for (const msg of this.displayMessages) {
			const row = this.messagesContainer.createDiv({ cls: `claude-msg-row ${msg.role}` });
			const bubble = row.createDiv({ cls: "claude-msg-bubble" });

			if (msg.role === "assistant") {
				MarkdownRenderer.render(this.app, msg.content || "…", bubble, "", this);
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
			this.usageBarFill.style.width = `${pct}%`;
			this.usageBarFill.toggleClass("over-limit", dollars >= limitDollars);
			this.usageBarFill.closest(".claude-usage-track")?.removeClass("hidden");
		} else {
			this.usageLabel.textContent = dollars > 0 ? `$${dollars.toFixed(3)} this month` : "";
			this.usageBarFill.style.width = "0%";
			this.usageBarFill.closest(".claude-usage-track")?.addClass("hidden");
		}
	}

	private renderAttachChip(container: HTMLElement) {
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
