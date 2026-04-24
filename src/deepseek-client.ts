import { OpenAICompatibleClient } from "./openai-compatible";

export class DeepSeekClient extends OpenAICompatibleClient {
	constructor(apiKey: string, model: string) {
		super({
			baseUrl: "https://api.deepseek.com",
			model,
			apiKey,
			providerName: "DeepSeek",
		});
	}
}
