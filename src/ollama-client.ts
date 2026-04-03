import type { MessageParam, ContentBlockParam, ToolResultBlockParam, TextBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import type { StreamCallbacks, ToolDefinition, ToolExecutor, AIClient } from "./claude-client";
import type { OllamaToolMode } from "./settings";

interface OAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface OAIMessage {
	role: string;
	content: string | null;
	tool_calls?: OAIToolCall[];
	tool_call_id?: string;
}

function anthropicToOAI(messages: MessageParam[]): OAIMessage[] {
	const result: OAIMessage[] = [];

	for (const msg of messages) {
		if (typeof msg.content === "string") {
			result.push({ role: msg.role, content: msg.content });
			continue;
		}

		const blocks = msg.content as ContentBlockParam[];

		if (msg.role === "assistant") {
			let textContent = "";
			const toolCalls: OAIToolCall[] = [];

			for (const block of blocks) {
				if (block.type === "text") {
					textContent += (block as TextBlockParam).text;
				} else if (block.type === "tool_use") {
					const tu = block as ToolUseBlock;
					toolCalls.push({
						id: tu.id,
						type: "function",
						function: {
							name: tu.name,
							arguments: JSON.stringify(tu.input),
						},
					});
				}
			}

			result.push({
				role: "assistant",
				content: textContent || null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		} else if (msg.role === "user") {
			const toolResults = blocks.filter(b => b.type === "tool_result") as ToolResultBlockParam[];
			const textBlocks = blocks.filter(b => b.type === "text") as TextBlockParam[];

			if (textBlocks.length > 0) {
				result.push({ role: "user", content: textBlocks.map(b => b.text).join("\n") });
			}

			for (const tr of toolResults) {
				result.push({
					role: "tool",
					tool_call_id: tr.tool_use_id,
					content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? ""),
				});
			}
		}
	}

	return result;
}

/** Build a system-prompt section that describes available tools for prompt-based calling. */
function buildToolPrompt(tools: ToolDefinition[]): string {
	const toolDescs = tools.map(t => {
		const params = t.input_schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
		const paramLines = Object.entries(params.properties ?? {}).map(([k, v]) => {
			const req = (params.required ?? []).includes(k) ? " (required)" : " (optional)";
			return `    - ${k}: ${v.description ?? v.type ?? "string"}${req}`;
		});
		return `- **${t.name}**: ${t.description}\n  Parameters:\n${paramLines.join("\n")}`;
	}).join("\n\n");

	return `\n\n## Available tools

You can call tools by writing a <tool_call> tag with a JSON object inside. You may call multiple tools in one response.

Format — each call must be EXACTLY:
<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

${toolDescs}

IMPORTANT:
- Always use <tool_call> tags when you need to interact with the vault.
- You may include normal text before or after tool calls.
- Wait for tool results before making assumptions about the outcome.`;
}

/** Parse <tool_call> blocks from model output text. Returns parsed calls and cleaned text. */
function parseToolCalls(text: string): { cleanedText: string; calls: Array<{ name: string; arguments: Record<string, unknown> }> } {
	const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	const cleaned = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_match, json: string) => {
		try {
			const parsed = JSON.parse(json) as { name: string; arguments: Record<string, unknown> };
			if (parsed.name) {
				calls.push({ name: parsed.name, arguments: parsed.arguments ?? {} });
			}
		} catch { /* skip malformed calls */ }
		return "";
	});
	return { cleanedText: cleaned.trim(), calls };
}

export class OllamaClient implements AIClient {
	private baseUrl: string;
	private model: string;
	private toolMode: OllamaToolMode;

	constructor(baseUrl: string, model: string, toolMode: OllamaToolMode = "prompt") {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.model = model;
		this.toolMode = toolMode;
	}

	async testConnection(): Promise<void> {
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/api/tags`);
		} catch {
			throw new Error(`Cannot connect to Ollama at ${this.baseUrl}. Make sure Ollama is running.`);
		}
		if (!response.ok) {
			throw new Error(`Ollama returned ${response.status}. Make sure Ollama is running.`);
		}
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
		const allMessages = [...messages];

		while (continueLoop) {
			continueLoop = false;

			const usePromptMode = this.toolMode === "prompt";

			const effectiveSystemPrompt = (usePromptMode && tools && tools.length > 0)
				? systemPrompt + buildToolPrompt(tools)
				: systemPrompt;

			const oaiMessages: OAIMessage[] = [
				{ role: "system", content: effectiveSystemPrompt },
				...anthropicToOAI(allMessages),
			];

			const requestBody: Record<string, unknown> = {
				model: this.model,
				messages: oaiMessages,
				stream: true,
			};

			if (!usePromptMode && tools && tools.length > 0) {
				requestBody.tools = tools.map(t => ({
					type: "function",
					function: {
						name: t.name,
						description: t.description,
						parameters: t.input_schema,
					},
				}));
			}

			let response: Response;
			try {
				response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(requestBody),
				});
			} catch {
				const error = new Error(`Cannot connect to Ollama at ${this.baseUrl}. Make sure Ollama is running.`);
				callbacks.onError?.(error);
				throw error;
			}

			if (!response.ok) {
				const error = new Error(`Ollama error: ${response.status} ${response.statusText}`);
				callbacks.onError?.(error);
				throw error;
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error("No response body from Ollama");

			const decoder = new TextDecoder();
			let fullText = "";
			const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					const chunk = decoder.decode(value, { stream: true });
					for (const line of chunk.split("\n")) {
						if (!line.startsWith("data: ")) continue;
						const data = line.slice(6).trim();
						if (data === "[DONE]") continue;

						let parsed: Record<string, unknown>;
						try {
							parsed = JSON.parse(data);
						} catch {
							continue;
						}

						const choices = parsed.choices as Array<{ delta: Record<string, unknown> }> | undefined;
						const delta = choices?.[0]?.delta;
						if (!delta) continue;

						if (typeof delta.content === "string") {
							fullText += delta.content;
							callbacks.onChunk?.(delta.content);
						}

						const tcs = delta.tool_calls as Array<{
							index?: number;
							id?: string;
							function?: { name?: string; arguments?: string };
						}> | undefined;

						if (tcs) {
							for (const tc of tcs) {
								const idx = tc.index ?? 0;
								if (!toolCallAccum.has(idx)) {
									toolCallAccum.set(idx, { id: "", name: "", arguments: "" });
								}
								const acc = toolCallAccum.get(idx)!;
								if (tc.id) acc.id = tc.id;
								if (tc.function?.name) acc.name = tc.function.name;
								if (tc.function?.arguments) acc.arguments += tc.function.arguments;
							}
						}
					}
				}
			} finally {
				reader.releaseLock();
			}

			// Build assistant message
			const contentBlocks: ContentBlockParam[] = [];
			const toolCalls: ToolUseBlock[] = [];

			// In prompt mode, parse <tool_call> tags from the text output
			if (usePromptMode && tools && tools.length > 0) {
				const { cleanedText, calls } = parseToolCalls(fullText);
				fullText = cleanedText;

				for (const call of calls) {
					const block: ToolUseBlock = {
						type: "tool_use",
						id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
						name: call.name,
						input: call.arguments,
					};
					toolCalls.push(block);
					contentBlocks.push(block);
				}
			} else {
				// Native mode — use accumulated tool_calls from the stream
				for (const [, tc] of toolCallAccum) {
					let input: Record<string, unknown> = {};
					try { input = JSON.parse(tc.arguments); } catch { /* leave empty */ }

					const block: ToolUseBlock = {
						type: "tool_use",
						id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
						name: tc.name,
						input,
					};
					toolCalls.push(block);
					contentBlocks.push(block);
				}
			}

			if (fullText) {
				contentBlocks.push({ type: "text", text: fullText });
			}

			if (contentBlocks.length > 0) {
				const assistantMsg: MessageParam = { role: "assistant", content: contentBlocks };
				allMessages.push(assistantMsg);
				newMessages.push(assistantMsg);
			}

			if (toolCalls.length > 0 && toolExecutor) {
				if (usePromptMode) {
					// In prompt mode, feed results back as plain text the model can understand
					const resultParts: string[] = [];
					for (const tc of toolCalls) {
						try {
							const result = await toolExecutor(tc.name, tc.input as Record<string, unknown>);
							resultParts.push(`<tool_result name="${tc.name}">\n${result}\n</tool_result>`);
						} catch (e) {
							const errMsg = e instanceof Error ? e.message : "Tool execution failed";
							resultParts.push(`<tool_result name="${tc.name}" error="true">\n${errMsg}\n</tool_result>`);
						}
					}
					const toolMsg: MessageParam = { role: "user", content: resultParts.join("\n\n") };
					allMessages.push(toolMsg);
					newMessages.push(toolMsg);
				} else {
					// Native mode — use standard tool_result format
					const toolResults: ToolResultBlockParam[] = [];
					for (const tc of toolCalls) {
						try {
							const result = await toolExecutor(tc.name, tc.input as Record<string, unknown>);
							toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
						} catch (e) {
							const errMsg = e instanceof Error ? e.message : "Tool execution failed";
							toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: errMsg, is_error: true });
						}
					}
					const toolMsg: MessageParam = { role: "user", content: toolResults };
					allMessages.push(toolMsg);
					newMessages.push(toolMsg);
				}
				continueLoop = true;
			}

			// Local models have no cost
			callbacks.onUsage?.(0, 0);

			if (!continueLoop && fullText) {
				callbacks.onComplete?.(fullText);
			}
		}

		return newMessages;
	}
}
