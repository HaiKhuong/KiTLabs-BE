import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

import {
  geminiKeyPoolEnvHint,
  loadGeminiKeyPools,
  resolveGeminiKeyTier,
  type GeminiKeyTier,
} from "../../common/gemini/gemini-key-pools";
import { ExecuteAiTaskDto } from "./dto/execute-ai-task.dto";

@Injectable()
export class VideosAiService {
  private readonly logger = new Logger(VideosAiService.name);
  private readonly normalKeys: string[];
  private readonly vipKeys: string[];
  private readonly keyIndices: Record<GeminiKeyTier, number> = { normal: 0, vip: 0 };

  constructor(private readonly configService: ConfigService) {
    const pools = loadGeminiKeyPools(this.configService);
    this.normalKeys = pools.normal;
    this.vipKeys = pools.vip;
    this.logger.log(
      `Videos AI: ${this.normalKeys.length} key Normal (GEMINI_API_KEY), ${this.vipKeys.length} key VIP (GEMINI_API_KEY_VIP)`,
    );
  }

  private getKeyPool(tier: GeminiKeyTier): string[] {
    return tier === "vip" ? this.vipKeys : this.normalKeys;
  }

  private getNextKey(tier: GeminiKeyTier): string {
    const pool = this.getKeyPool(tier);
    if (pool.length === 0) {
      throw new BadRequestException(
        `Gemini API key (${tier}) chưa cấu hình. Set ${geminiKeyPoolEnvHint(tier)} trong .env`,
      );
    }
    const key = pool[this.keyIndices[tier]];
    this.keyIndices[tier] = (this.keyIndices[tier] + 1) % pool.length;
    return key;
  }

  private resolveModelName(model: string): string {
    const normalized = model.trim().toLowerCase();
    if (normalized === "gpt-2.5-flash" || normalized === "gemini-2.5-flash") {
      return "gemini-2.5-flash";
    }
    if (normalized.includes("2.5-pro")) return "gemini-2.5-pro";
    if (normalized.includes("2.0-flash")) return "gemini-2.0-flash";
    return this.configService.get<string>("VIDEOS_AI_MODEL") ?? "gemini-2.5-flash";
  }

  /** Replace {{script}} when script is provided; otherwise leave prompt unchanged. */
  buildFinalPrompt(prompt: string, script?: string): string {
    const scriptValue = script?.trim() ?? "";
    if (!scriptValue) return prompt;
    return prompt.replace(/\{\{\s*script\s*\}\}/gi, scriptValue);
  }

  private tryParseJson(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenced?.[1]) {
        try {
          return JSON.parse(fenced[1].trim());
        } catch {
          return trimmed;
        }
      }
      return trimmed;
    }
  }

  async executeAiTask(dto: ExecuteAiTaskDto): Promise<{
    provider: string;
    model: string;
    apiKeyTier: GeminiKeyTier;
    prompt: string;
    result: unknown;
    raw: string;
  }> {
    const prompt = dto.prompt?.trim();
    if (!prompt) {
      throw new BadRequestException("prompt is required");
    }

    const finalPrompt = this.buildFinalPrompt(prompt, dto.script);
    const provider = dto.provider?.trim();
    if (!provider) {
      throw new BadRequestException("provider is required");
    }
    const modelInput = dto.model?.trim();
    if (!modelInput) {
      throw new BadRequestException("model is required");
    }
    const modelName = this.resolveModelName(modelInput);
    const apiKeyTier = resolveGeminiKeyTier(dto.apiKeyTier);
    const keyPool = this.getKeyPool(apiKeyTier);
    const maxAttempts = Math.max(keyPool.length, 1);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const genAI = new GoogleGenerativeAI(this.getNextKey(apiKeyTier));
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.4,
            responseMimeType: "application/json",
          },
        });

        const response = await model.generateContent(finalPrompt);
        const raw = response.response.text() ?? "";
        const result = this.tryParseJson(raw);

        return {
          provider,
          model: modelName,
          apiKeyTier,
          prompt: finalPrompt,
          result,
          raw,
        };
      } catch (error: any) {
        lastError = error;
        const status = error?.status ?? error?.httpStatusCode ?? 0;
        const isRetryable = status === 429 || status === 503 || status === 500;
        if (isRetryable && attempt < maxAttempts - 1) {
          this.logger.warn(`Videos AI ${apiKeyTier} key failed (${status}), rotating...`);
          continue;
        }
        break;
      }
    }

    const message =
      lastError instanceof Error ? lastError.message : "AI Task execution failed";
    this.logger.error(`AI Task failed (${apiKeyTier}): ${message}`);
    throw new BadRequestException(message);
  }
}
