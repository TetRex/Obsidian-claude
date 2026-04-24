import type { AIProvider } from "./settings";

export interface ModelOption {
	value: string;
	label: string;
	inputCostPerMillion?: number;
	outputCostPerMillion?: number;
}

export const ANTHROPIC_MODELS: ModelOption[] = [
	{
		value: "claude-opus-4-6",
		label: "Claude Opus 4.6",
		inputCostPerMillion: 5,
		outputCostPerMillion: 25,
	},
	{
		value: "claude-sonnet-4-6",
		label: "Claude Sonnet 4.6",
		inputCostPerMillion: 3,
		outputCostPerMillion: 15,
	},
	{
		value: "claude-haiku-4-5",
		label: "Claude Haiku 4.5",
		inputCostPerMillion: 1,
		outputCostPerMillion: 5,
	},
];

export const OPENAI_MODELS: ModelOption[] = [
	{
		value: "gpt-5.5",
		label: "GPT-5.5",
		inputCostPerMillion: 5,
		outputCostPerMillion: 30,
	},
	{
		value: "gpt-5.4-mini",
		label: "GPT-5.4 mini",
		inputCostPerMillion: 0.75,
		outputCostPerMillion: 4.5,
	},
	{
		value: "gpt-5.4-nano",
		label: "GPT-5.4 nano",
		inputCostPerMillion: 0.2,
		outputCostPerMillion: 1.25,
	},
];

export const GEMINI_MODELS: ModelOption[] = [
	{
		value: "gemini-2.5-pro",
		label: "Gemini 2.5 Pro",
		inputCostPerMillion: 1.25,
		outputCostPerMillion: 10,
	},
	{
		value: "gemini-2.5-flash",
		label: "Gemini 2.5 Flash",
		inputCostPerMillion: 0.3,
		outputCostPerMillion: 2.5,
	},
	{
		value: "gemini-2.5-flash-lite",
		label: "Gemini 2.5 Flash-Lite",
		inputCostPerMillion: 0.1,
		outputCostPerMillion: 0.4,
	},
];

export const OLLAMA_DEFAULT_MODEL = "qwen3.6";

export const LEGACY_MODEL_MIGRATIONS: Partial<Record<AIProvider, Record<string, string>>> = {
	anthropic: {
		"claude-opus-4-0": "claude-opus-4-6",
		"claude-opus-4-1": "claude-opus-4-6",
		"claude-opus-4-5": "claude-opus-4-6",
		"claude-sonnet-4-0": "claude-sonnet-4-6",
		"claude-sonnet-4-5": "claude-sonnet-4-6",
		"claude-3-7-sonnet-latest": "claude-sonnet-4-6",
		"claude-3-5-haiku-latest": "claude-haiku-4-5",
	},
	openai: {
		"gpt-5": "gpt-5.5",
		"gpt-5.2": "gpt-5.5",
		"gpt-5.2-pro": "gpt-5.5",
		"gpt-5.4": "gpt-5.5",
		"gpt-5-mini": "gpt-5.4-mini",
		"gpt-5-nano": "gpt-5.4-nano",
	},
	gemini: {
		"openrouter/auto": "gemini-2.5-flash",
		"google/gemini-2.5-pro": "gemini-2.5-pro",
		"google/gemini-2.5-flash": "gemini-2.5-flash",
		"google/gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
	},
};

export const MODEL_COSTS: Record<string, { input: number; output: number }> = Object.fromEntries(
	([
		...ANTHROPIC_MODELS.map((model) => ["anthropic", model] as const),
		...OPENAI_MODELS.map((model) => ["openai", model] as const),
		...GEMINI_MODELS.map((model) => ["gemini", model] as const),
	]
		.filter(([, model]) => model.inputCostPerMillion !== undefined && model.outputCostPerMillion !== undefined)
		.map(([provider, model]) => [
			`${provider}:${model.value}`,
			{
				input: (model.inputCostPerMillion ?? 0) / 1_000_000,
				output: (model.outputCostPerMillion ?? 0) / 1_000_000,
			},
		]))
);
