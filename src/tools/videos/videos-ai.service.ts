import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { ExecuteAiTaskDto } from "./dto/execute-ai-task.dto";

@Injectable()
export class VideosAiService {
  private readonly logger = new Logger(VideosAiService.name);
  private readonly apiKeys: string[];
  private currentKeyIndex = 0;

  constructor(private readonly configService: ConfigService) {
    this.apiKeys = this.parseKeys();
    this.logger.log(`Videos AI: loaded ${this.apiKeys.length} Gemini key(s)`);
  }

  private parseKeys(): string[] {
    const raw =
      this.configService.get<string>("GEMINI_API_KEY_VIP") ??
      this.configService.get<string>("GEMINI_API_KEY") ??
      "";
    return raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }

  private getNextKey(): string {
    if (this.apiKeys.length === 0) {
      throw new BadRequestException("Gemini API key is not configured");
    }
    const key = this.apiKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
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
    prompt: string;
    result: unknown;
    raw: string;
  }> {
    const prompt = dto.prompt?.trim();
    if (!prompt) {
      throw new BadRequestException("prompt is required");
    }

    const finalPrompt = this.buildFinalPrompt(prompt, dto.script);
    const modelName = this.resolveModelName(dto.model || "gpt-2.5-flash");
    const provider = dto.provider?.trim() || "openai";

    const maxAttempts = Math.max(this.apiKeys.length, 1);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const genAI = new GoogleGenerativeAI(this.getNextKey());
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
          prompt: finalPrompt,
          result,
          raw,
        };
      } catch (error: any) {
        lastError = error;
        const status = error?.status ?? error?.httpStatusCode ?? 0;
        const isRetryable = status === 429 || status === 503 || status === 500;
        if (isRetryable && attempt < maxAttempts - 1) {
          this.logger.warn(`Videos AI key failed (${status}), rotating...`);
          continue;
        }
        break;
      }
    }

    const message =
      lastError instanceof Error ? lastError.message : "AI Task execution failed";
    this.logger.error(`AI Task failed: ${message}`);
    throw new BadRequestException(message);
  }
}
