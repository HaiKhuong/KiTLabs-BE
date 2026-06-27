import { Injectable } from "@nestjs/common";

import { AiProvider, AiAnalysisInput, AiRecommendationOutput, AiChatResponse } from "./ai-provider.interface";
import { GeminiProvider } from "./gemini.provider";

@Injectable()
export class AiService implements AiProvider {
  constructor(private readonly geminiProvider: GeminiProvider) {}

  private getProvider(): AiProvider {
    // Strategy pattern: extend here to support GPT, Claude, Local LLM
    return this.geminiProvider;
  }

  async analyze(input: AiAnalysisInput): Promise<AiRecommendationOutput> {
    return this.getProvider().analyze(input);
  }

  async chat(
    systemContext: string,
    userMessage: string,
    history?: Array<{ role: string; content: string }>,
  ): Promise<AiChatResponse> {
    return this.getProvider().chat(systemContext, userMessage, history);
  }
}
