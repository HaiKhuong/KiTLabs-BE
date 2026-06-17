import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

import { CompareSubtitleBlockDto } from "./dto/translate-compare-subtitle.dto";

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

@Injectable()
export class GeminiSubtitleTranslateService {
  private readonly modelName: string;
  private readonly batchSize: number;
  private readonly apiKeys: string[];

  constructor(private readonly configService: ConfigService) {
    this.modelName = this.configService.get<string>("GEMINI_MODEL_NAME") ?? "gemini-2.5-flash";
    this.batchSize = Number(this.configService.get<string>("TRANSLATE_BATCH_SIZE") ?? 20);
    this.apiKeys = this.resolveApiKeys();
  }

  private resolveApiKeys(): string[] {
    const raw =
      this.configService.get<string>("GEMINI_API_KEY") ??
      this.configService.get<string>("GOOGLE_API_KEY") ??
      "";
    const keys = raw
      .split(/[,;\n]+/)
      .map((k) => k.trim())
      .filter(Boolean);
    return [...new Set(keys)];
  }

  async translateBlocks(
    blocks: CompareSubtitleBlockDto[],
    translationContext?: string,
  ): Promise<CompareSubtitleBlockDto[]> {
    if (!this.apiKeys.length) {
      throw new BadRequestException(
        "Missing GEMINI_API_KEY (or GOOGLE_API_KEY) on server.",
      );
    }

    const translated: CompareSubtitleBlockDto[] = [];
    for (let i = 0; i < blocks.length; i += this.batchSize) {
      const batch = blocks.slice(i, i + this.batchSize);
      const mapping = await this.translateBatch(batch, translationContext);
      for (let localIdx = 0; localIdx < batch.length; localIdx += 1) {
        const source = batch[localIdx];
        const viText = mapping.get(localIdx) ?? source.text;
        translated.push({
          index: source.index,
          timestamp: source.timestamp,
          text: viText,
        });
      }
    }
    return translated;
  }

  private async translateBatch(
    batch: CompareSubtitleBlockDto[],
    translationContext?: string,
  ): Promise<Map<number, string>> {
    const payloadLines = batch.map((b, i) => `${i}:|${b.text}`);
    const payloadText = payloadLines.join("\n");

    const promptParts = [
      "Translate Chinese subtitles into Vietnamese.\n",
      "Write very concise, subtitle-friendly Vietnamese.\n",
      "Keep original meaning and emotional tone, but simplify phrasing.\n",
      "Preserve historical tone, titles, names, and relationships.\n",
    ];

    if (translationContext?.trim()) {
      promptParts.push(`${translationContext.trim()}\n`);
    } else {
      promptParts.push("Han-Viet terms OK. Historical/wuxia context.\n");
    }

    promptParts.push(`Output same format: id:|vi\n${payloadText}`);
    const prompt = promptParts.join("");

    const rawText = await this.callGemini(prompt);
    return this.parseResponse(rawText);
  }

  private async callGemini(prompt: string): Promise<string> {
    let lastError: unknown;
    for (const apiKey of this.apiKeys) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelName)}:generateContent`;
        const response = await axios.post<GeminiGenerateResponse>(
          url,
          { contents: [{ parts: [{ text: prompt }] }] },
          {
            params: { key: apiKey },
            timeout: 120_000,
            headers: { "Content-Type": "application/json" },
          },
        );
        const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (!text.trim()) {
          throw new Error("Gemini returned empty text.");
        }
        return text;
      } catch (error) {
        lastError = error;
      }
    }
    const message =
      lastError instanceof Error ? lastError.message : "Gemini translation failed.";
    throw new InternalServerErrorException(message);
  }

  private parseResponse(text: string): Map<number, string> {
    const mapped = new Map<number, string>();

    try {
      const match = text.trim().match(/\[[\s\S]*\]/);
      if (match) {
        const data = JSON.parse(match[0]) as Array<{ id?: number; vi?: string }>;
        for (const item of data) {
          if (item.id === undefined || item.vi === undefined) continue;
          mapped.set(Number(item.id), String(item.vi).trim());
        }
        if (mapped.size > 0) return mapped;
      }
    } catch {
      // fallback to line format
    }

    for (const line of text.trim().split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\d+):\|(.*)$/);
      if (!m) continue;
      const localIdx = Number(m[1]);
      let content = m[2].trim();
      content = content.replace(/^vi\s*[:：]\s*/i, "");
      if (!Number.isNaN(localIdx)) mapped.set(localIdx, content);
    }

    if (mapped.size === 0) {
      throw new InternalServerErrorException(
        `Cannot parse Gemini response: ${text.slice(0, 200)}`,
      );
    }
    return mapped;
  }
}
