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
        const viText = mapping.get(localIdx);
        if (!viText?.trim()) {
          throw new InternalServerErrorException(
            `Gemini missing translation for line ${localIdx} in batch starting at index ${source.index}.`,
          );
        }
        translated.push({
          index: source.index,
          timestamp: source.timestamp,
          text: viText,
        });
      }
    }
    return translated;
  }

  private buildTranslatePrompt(
    batch: CompareSubtitleBlockDto[],
    payloadText: string,
    translationContext?: string,
  ): string {
    const lineCount = batch.length;
    const lastId = lineCount - 1;
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

    promptParts.push(
      `INPUT: exactly ${lineCount} lines (ids 0 to ${lastId}):\n` +
        `${payloadText}\n\n` +
        "OUTPUT RULES (mandatory):\n" +
        `- Return exactly ${lineCount} lines with ids 0 to ${lastId}, same order as input.\n` +
        "- Translate each input line separately into exactly one output line.\n" +
        "- Do NOT merge, split, skip, deduplicate, summarize, or reorder lines.\n" +
        "- Do NOT combine short consecutive lines into one translation.\n" +
        "- Format each output line: id:|Vietnamese translation\n" +
        "- Output ONLY translated lines. No notes, no markdown, no extra text.\n",
    );
    return promptParts.join("");
  }

  private async translateBatch(
    batch: CompareSubtitleBlockDto[],
    translationContext?: string,
  ): Promise<Map<number, string>> {
    const payloadLines = batch.map((b, i) => `${i}:|${b.text}`);
    const payloadText = payloadLines.join("\n");
    const prompt = this.buildTranslatePrompt(batch, payloadText, translationContext);
    const maxRetry = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
      try {
        const rawText = await this.callGemini(prompt);
        const parsed = this.parseResponse(rawText);
        return this.normalizeBatchMapping(parsed, batch);
      } catch (error) {
        lastError = error;
      }
    }

    const message =
      lastError instanceof Error ? lastError.message : "Gemini translation failed.";
    throw new InternalServerErrorException(message);
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

  private normalizeBatchMapping(
    mapped: Map<number, string>,
    batch: CompareSubtitleBlockDto[],
  ): Map<number, string> {
    const expectedCount = batch.length;
    const complete = (localMap: Map<number, string>): boolean =>
      Array.from({ length: expectedCount }, (_, i) => i).every(
        (i) => localMap.has(i) && String(localMap.get(i) ?? "").trim().length > 0,
      );

    if (complete(mapped)) {
      return mapped;
    }

    const blockToLocal = new Map<number, number>();
    batch.forEach((block, localIdx) => {
      blockToLocal.set(Number(block.index), localIdx);
    });
    const blockMap = new Map<number, string>();
    for (const [key, value] of mapped.entries()) {
      const localIdx = blockToLocal.get(Number(key));
      if (localIdx !== undefined) {
        blockMap.set(localIdx, value);
      }
    }
    if (complete(blockMap)) {
      return blockMap;
    }

    const gotIds = [...mapped.keys()].sort((a, b) => a - b);
    throw new InternalServerErrorException(
      `Gemini line count mismatch: expected ${expectedCount} lines (ids 0..${expectedCount - 1}), got ids ${gotIds.join(", ")}`,
    );
  }
}
