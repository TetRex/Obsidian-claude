import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam, ToolUseBlock, ToolResultBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";

export interface StreamCallbacks {
	onChunk?: (text: string) => void;
	onComplete?: (fullText: string) => void;
	onError?: (error: Error) => void;
	onUsage?: (inputTokens: number, outputTokens: number) => void;
}

export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

export interface ToolExecutor {
	(name: string, input: Record<string, unknown>): Promise<string>;
}

export class ClaudeClient {
	private client: Anthropic;
	private model: string;

	constructor(apiKey: string, model: string) {
		this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
		this.model = model;
	}

	async testConnection(): Promise<void> {
		await this.client.messages.create({
			model: this.model,
			max_tokens: 16,
			messages: [{ role: "user", content: "Hi" }],
		});
	}

	async streamMessage(
		systemPrompt: string,
		messages: MessageParam[],
		callbacks: StreamCallbacks,
		tools?: ToolDefinition[],
		toolExecutor?: ToolExecutor
	): Promise<MessageParam[]> {
		const newMessages: MessageParam[] = [];
		let continueLoop = true;

		// Copy messages to avoid mutating the caller's array
		const allMessages = [...messages];

		while (continueLoop) {
			continueLoop = false;
			let fullText = "";
			const contentBlocks: ContentBlockParam[] = [];
			const toolCalls: ToolUseBlock[] = [];

			try {
				const systemBlocks: TextBlockParam[] = [
					{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
				];

				const params: Anthropic.MessageCreateParams = {
					model: this.model,
					max_tokens: 4096,
					system: systemBlocks,
					messages: allMessages,
					stream: true,
				};
				if (tools && tools.length > 0) {
					const cachedTools = tools.map((t, i) =>
						i === tools.length - 1
							? { ...t, cache_control: { type: "ephemeral" as const } }
							: t
					);
					(params as Record<string, unknown>).tools = cachedTools;
				}

				const stream = this.client.messages.stream(params);

				for await (const event of stream) {
					if (event.type === "content_block_delta") {
						const delta = event.delta;
						if ("text" in delta && delta.text) {
							fullText += delta.text;
							callbacks.onChunk?.(delta.text);
						}
					}
				}

				// Get final message once — extracts tool calls and usage
				const finalMsg = await stream.finalMessage();

				for (const block of finalMsg.content) {
					if (block.type === "tool_use") {
						toolCalls.push(block);
					}
				}

				// Report token usage for cost tracking
				if (finalMsg.usage) {
					callbacks.onUsage?.(
						finalMsg.usage.input_tokens,
						finalMsg.usage.output_tokens
					);
				}

				// Build assistant content blocks
				if (fullText) {
					contentBlocks.push({ type: "text", text: fullText });
				}
				for (const tc of toolCalls) {
					contentBlocks.push(tc);
				}

				if (contentBlocks.length > 0) {
					const assistantMsg: MessageParam = {
						role: "assistant",
						content: contentBlocks,
					};
					allMessages.push(assistantMsg);
					newMessages.push(assistantMsg);
				}

				// Handle tool calls
				if (toolCalls.length > 0 && toolExecutor) {
					const toolResults: ToolResultBlockParam[] = [];
					for (const tc of toolCalls) {
						try {
							const result = await toolExecutor(
								tc.name,
								tc.input as Record<string, unknown>
							);
							toolResults.push({
								type: "tool_result",
								tool_use_id: tc.id,
								content: result,
							});
						} catch (e) {
							const errMsg =
								e instanceof Error
									? e.message
									: "Tool execution failed";
							toolResults.push({
								type: "tool_result",
								tool_use_id: tc.id,
								content: errMsg,
								is_error: true,
							});
						}
					}

					const toolMsg: MessageParam = {
						role: "user",
						content: toolResults,
					};
					allMessages.push(toolMsg);
					newMessages.push(toolMsg);
					continueLoop = true; // Continue the agentic loop
				}
			} catch (e) {
				const error =
					e instanceof Error ? e : new Error("Unknown error");
				this.handleApiError(error);
				callbacks.onError?.(error);
				throw error;
			}

			if (!continueLoop && fullText) {
				callbacks.onComplete?.(fullText);
			}
		}

		return newMessages;
	}

	private handleApiError(error: Error): void {
		const msg = error.message.toLowerCase();
		if (msg.includes("401") || msg.includes("authentication")) {
			throw new Error(
				"Authentication failed. Please check your API key."
			);
		} else if (msg.includes("429") || msg.includes("rate limit")) {
			throw new Error("Rate limited. Please wait a moment and try again.");
		} else if (
			msg.includes("network") ||
			msg.includes("fetch") ||
			msg.includes("econnrefused")
		) {
			throw new Error(
				"Network error. Please check your internet connection."
			);
		}
	}
}
