import { Injectable } from "@nestjs/common";

import { AiProvider, AiAnalysisInput, AiRecommendationOutput } from "./ai-provider.interface";
import { GeminiProvider } from "./gemini.provider";

@Injectable()
export class AiService implements AiProvider {
  constructor(private readonly geminiProvider: GeminiProvider) {}

  private getProvider(): AiProvider {
    return this.geminiProvider;
  }

  async analyze(input: AiAnalysisInput): Promise<AiRecommendationOutput> {
    return this.getProvider().analyze(input);
  }
}
