import type {
	ContentBlockParam,
	MessageParam,
	TextBlockParam,
	ToolResultBlockParam,
	ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { AIClient, StreamCallbacks, ToolDefinition, ToolExecutor } from "./claude-client";

export interface OAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface OAIMessage {
	role: string;
	content: string | null;
	tool_calls?: OAIToolCall[];
	tool_call_id?: string;
}

interface OpenAICompatibleStreamOptions {
	baseUrl: string;
	model: string;
	providerName: string;
	systemPrompt: string;
	messages: MessageParam[];
	callbacks: StreamCallbacks;
	tools?: ToolDefinition[];
	toolExecutor?: ToolExecutor;
	apiKey?: string;
	headers?: Record<string, string>;
	requestBody?: Record<string, unknown>;
}

export function anthropicToOAI(messages: MessageParam[]): OAIMessage[] {
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
					const toolUse = block as ToolUseBlock;
					toolCalls.push({
						id: toolUse.id,
						type: "function",
						function: {
							name: toolUse.name,
							arguments: JSON.stringify(toolUse.input),
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
			const toolResults = blocks.filter(block => block.type === "tool_result") as ToolResultBlockParam[];
			const textBlocks = blocks.filter(block => block.type === "text") as TextBlockParam[];

			if (textBlocks.length > 0) {
				result.push({
					role: "user",
					content: textBlocks.map(block => block.text).join("\n"),
				});
			}

			for (const toolResult of toolResults) {
				result.push({
					role: "tool",
					tool_call_id: toolResult.tool_use_id,
					content: typeof toolResult.content === "string"
						? toolResult.content
						: JSON.stringify(toolResult.content ?? ""),
				});
			}
		}
	}

	return result;
}

export async function streamOpenAICompatibleMessage({
	baseUrl,
	model,
	providerName,
	systemPrompt,
	messages,
	callbacks,
	tools,
	toolExecutor,
	apiKey,
	headers,
	requestBody,
}: OpenAICompatibleStreamOptions): Promise<MessageParam[]> {
	const newMessages: MessageParam[] = [];
	let continueLoop = true;
	const allMessages = [...messages];

	while (continueLoop) {
		continueLoop = false;

		const oaiMessages: OAIMessage[] = [
			{ role: "system", content: systemPrompt },
			...anthropicToOAI(allMessages),
		];

		const body: Record<string, unknown> = {
			model,
			messages: oaiMessages,
			stream: true,
			...(requestBody ?? {}),
		};

		if (tools && tools.length > 0) {
			body.tools = tools.map(tool => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.input_schema,
				},
			}));
		}

		const requestHeaders: Record<string, string> = {
			"Content-Type": "application/json",
			...(headers ?? {}),
		};
		if (apiKey) {
			requestHeaders.Authorization = `Bearer ${apiKey}`;
		}

		let response: Response;
		try {
			response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				headers: requestHeaders,
				body: JSON.stringify(body),
			});
		} catch {
			const error = new Error(`Cannot connect to ${providerName}.`);
			callbacks.onError?.(error);
			throw error;
		}

		if (!response.ok) {
			let details = `${response.status} ${response.statusText}`;
			try {
				const data = await response.json() as { error?: { message?: string } };
				if (data.error?.message) details = data.error.message;
			} catch {
				// Ignore JSON parse failures and keep the status text.
			}

			const error = new Error(`${providerName} error: ${details}`);
			callbacks.onError?.(error);
			throw error;
		}

		const reader = response.body?.getReader();
		if (!reader) throw new Error(`No response body from ${providerName}`);

		const decoder = new TextDecoder();
		let fullText = "";
		let sseBuffer = "";
		let usageReported = false;
		const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

		const processSseLine = (line: string) => {
			if (!line.startsWith("data: ")) return;

			const data = line.slice(6).trim();
			if (data === "[DONE]") return;

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(data);
			} catch {
				return;
			}

			const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
			if (usage && !usageReported) {
				callbacks.onUsage?.(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
				usageReported = true;
			}

			const choices = parsed.choices as Array<{ delta?: Record<string, unknown>; message?: Record<string, unknown> }> | undefined;
			const delta = choices?.[0]?.delta ?? choices?.[0]?.message;
			if (!delta) return;

			if (typeof delta.content === "string") {
				fullText += delta.content;
				callbacks.onChunk?.(delta.content);
			}

			const toolCalls = delta.tool_calls as Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}> | undefined;
			if (!toolCalls) return;

			for (const toolCall of toolCalls) {
				const idx = toolCall.index ?? 0;
				if (!toolCallAccum.has(idx)) {
					toolCallAccum.set(idx, { id: "", name: "", arguments: "" });
				}

				const acc = toolCallAccum.get(idx);
				if (!acc) continue;

				if (toolCall.id) acc.id = toolCall.id;
				if (toolCall.function?.name) acc.name = toolCall.function.name;
				if (toolCall.function?.arguments) acc.arguments += toolCall.function.arguments;
			}
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				sseBuffer += decoder.decode(value, { stream: !done });

				const lines = sseBuffer.split("\n");
				sseBuffer = done ? "" : (lines.pop() ?? "");

				for (const line of lines) {
					processSseLine(line);
				}

				if (done) {
					if (sseBuffer.trim()) processSseLine(sseBuffer);
					break;
				}
			}
		} finally {
			reader.releaseLock();
		}

		const contentBlocks: ContentBlockParam[] = [];
		const toolCalls: ToolUseBlock[] = [];

		for (const [, toolCall] of toolCallAccum) {
			let input: Record<string, unknown> = {};
			try {
				input = JSON.parse(toolCall.arguments);
			} catch {
				// Leave invalid tool arguments empty so tool execution surfaces the error.
			}

			const block: ToolUseBlock = {
				type: "tool_use",
				id: toolCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
				name: toolCall.name,
				input,
			};
			toolCalls.push(block);
			contentBlocks.push(block);
		}

		if (fullText) {
			contentBlocks.push({ type: "text", text: fullText });
		}

		if (contentBlocks.length > 0) {
			const assistantMsg: MessageParam = {
				role: "assistant",
				content: contentBlocks,
			};
			allMessages.push(assistantMsg);
			newMessages.push(assistantMsg);
		}

		if (toolCalls.length > 0 && toolExecutor) {
			const toolResults: ToolResultBlockParam[] = [];
			for (const toolCall of toolCalls) {
				try {
					const result = await toolExecutor(toolCall.name, toolCall.input as Record<string, unknown>);
					toolResults.push({
						type: "tool_result",
						tool_use_id: toolCall.id,
						content: result,
					});
				} catch (e) {
					const errMsg = e instanceof Error ? e.message : "Tool execution failed";
					toolResults.push({
						type: "tool_result",
						tool_use_id: toolCall.id,
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
			continueLoop = true;
		}

		if (!usageReported) {
			callbacks.onUsage?.(0, 0);
		}

		if (!continueLoop && fullText) {
			callbacks.onComplete?.(fullText);
		}
	}

	return newMessages;
}

export class OpenAICompatibleClient implements AIClient {
	private baseUrl: string;
	private model: string;
	private providerName: string;
	private apiKey?: string;
	private headers?: Record<string, string>;
	private requestBody?: Record<string, unknown>;

	constructor(options: {
		baseUrl: string;
		model: string;
		providerName: string;
		apiKey?: string;
		headers?: Record<string, string>;
		requestBody?: Record<string, unknown>;
	}) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.model = options.model;
		this.providerName = options.providerName;
		this.apiKey = options.apiKey;
		this.headers = options.headers;
		this.requestBody = options.requestBody;
	}

	async testConnection(): Promise<void> {
		const testRequestBody: Record<string, unknown> = { ...(this.requestBody ?? {}) };
		delete testRequestBody.stream_options;

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
					...(this.headers ?? {}),
				},
				body: JSON.stringify({
					model: this.model,
					messages: [{ role: "user", content: "Hi" }],
					stream: false,
					max_tokens: 16,
					...testRequestBody,
				}),
			});
		} catch {
			throw new Error(`Cannot connect to ${this.providerName}.`);
		}

		if (!response.ok) {
			let details = `${response.status} ${response.statusText}`;
			try {
				const data = await response.json() as { error?: { message?: string } };
				if (data.error?.message) details = data.error.message;
			} catch {
				// Ignore response parsing failures.
			}
			throw new Error(`${this.providerName} error: ${details}`);
		}
	}

	async streamMessage(
		systemPrompt: string,
		messages: MessageParam[],
		callbacks: StreamCallbacks,
		tools?: ToolDefinition[],
		toolExecutor?: ToolExecutor
	): Promise<MessageParam[]> {
		return streamOpenAICompatibleMessage({
			baseUrl: this.baseUrl,
			model: this.model,
			providerName: this.providerName,
			systemPrompt,
			messages,
			callbacks,
			tools,
			toolExecutor,
			apiKey: this.apiKey,
			headers: this.headers,
			requestBody: this.requestBody,
		});
	}
}
