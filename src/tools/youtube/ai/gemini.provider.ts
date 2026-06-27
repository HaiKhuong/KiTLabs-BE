import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";

import { AiProvider, AiAnalysisInput, AiRecommendationOutput, AiChatResponse } from "./ai-provider.interface";
import { SYSTEM_PROMPT } from "./prompts/system.prompt";
import { RECOMMENDATION_PROMPT } from "./prompts/recommendation.prompt";
import { CHAT_CONTEXT_PROMPT } from "./prompts/chat.prompt";

@Injectable()
export class GeminiProvider implements AiProvider {
  private readonly logger = new Logger(GeminiProvider.name);
  private readonly apiKeys: string[];
  private currentKeyIndex = 0;

  constructor(private readonly configService: ConfigService) {
    this.apiKeys = this.parseKeys();
    this.logger.log(`Loaded ${this.apiKeys.length} Gemini VIP key(s)`);
  }

  private parseKeys(): string[] {
    const raw = this.configService.get("GEMINI_API_KEY_VIP") ?? this.configService.get("GEMINI_API_KEY") ?? "";
    return raw
      .split(",")
      .map((k: string) => k.trim())
      .filter(Boolean);
  }

  private getNextKey(): string {
    if (this.apiKeys.length === 0) return "";
    const key = this.apiKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  private createClient(): GoogleGenerativeAI {
    return new GoogleGenerativeAI(this.getNextKey());
  }

  private getModel(genAI: GoogleGenerativeAI, json = true): GenerativeModel {
    const modelName = this.configService.get("YOUTUBE_AI_MODEL") ?? "gemini-2.5-pro";
    const temperature = parseFloat(this.configService.get("YOUTUBE_AI_TEMPERATURE") ?? "0.2");

    return genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature,
        ...(json ? { responseMimeType: "application/json" } : {}),
      },
    });
  }

  /**
   * Retry with key rotation: nếu key hiện tại bị rate-limit/lỗi,
   * tự động xoay sang key tiếp theo (tối đa thử hết tất cả keys).
   */
  private async withRetry<T>(fn: (genAI: GoogleGenerativeAI) => Promise<T>): Promise<T> {
    const maxAttempts = Math.max(this.apiKeys.length, 1);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const genAI = this.createClient();
        return await fn(genAI);
      } catch (error: any) {
        lastError = error;
        const status = error?.status ?? error?.httpStatusCode ?? 0;
        const isRetryable = status === 429 || status === 503 || status === 500;

        if (isRetryable && attempt < maxAttempts - 1) {
          this.logger.warn(`Key #${((this.currentKeyIndex - 1 + this.apiKeys.length) % this.apiKeys.length) + 1} failed (${status}), rotating to next key...`);
          continue;
        }
        break;
      }
    }

    throw lastError;
  }

  async analyze(input: AiAnalysisInput): Promise<AiRecommendationOutput> {
    const prompt = RECOMMENDATION_PROMPT.replace("{DATA}", JSON.stringify(input, null, 2));

    try {
      const text = await this.withRetry(async (genAI) => {
        const model = this.getModel(genAI, true);
        const result = await model.generateContent({
          contents: [
            { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
            { role: "model", parts: [{ text: "Understood. I will analyze the data and provide structured JSON recommendations." }] },
            { role: "user", parts: [{ text: prompt }] },
          ],
        });
        return result.response.text();
      });

      const parsed = JSON.parse(text);

      return {
        summary: parsed.summary ?? "",
        recommendations: parsed.recommendations ?? [],
        warnings: parsed.warnings ?? [],
        nextActions: parsed.nextActions ?? parsed.next_actions ?? [],
      };
    } catch (error) {
      this.logger.error(`Gemini analysis failed: ${error}`);
      return {
        summary: "Analysis failed due to an error.",
        recommendations: [],
        warnings: ["AI analysis encountered an error. Please try again."],
        nextActions: [],
      };
    }
  }

  async chat(
    systemContext: string,
    userMessage: string,
    history?: Array<{ role: string; content: string }>,
  ): Promise<AiChatResponse> {
    const contextPrompt = CHAT_CONTEXT_PROMPT.replace("{CONTEXT}", systemContext);

    const contents = [
      { role: "user" as const, parts: [{ text: contextPrompt }] },
      { role: "model" as const, parts: [{ text: "I understand the context. I'm ready to help manage your YouTube channel." }] },
    ];

    if (history) {
      for (const msg of history) {
        contents.push({
          role: msg.role === "user" ? ("user" as const) : ("model" as const),
          parts: [{ text: msg.content }],
        });
      }
    }

    contents.push({ role: "user" as const, parts: [{ text: userMessage }] });

    try {
      const text = await this.withRetry(async (genAI) => {
        const chatModel = this.getModel(genAI, false);
        const result = await chatModel.generateContent({ contents });
        return result.response.text();
      });

      return { content: text };
    } catch (error) {
      this.logger.error(`Gemini chat failed: ${error}`);
      return { content: "Xin lỗi, đã có lỗi xảy ra khi xử lý câu hỏi của bạn. Vui lòng thử lại." };
    }
  }
}
