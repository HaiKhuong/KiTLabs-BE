import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { readFileSync } from "fs";
import { extname } from "path";

import { geminiKeyPoolEnvHint, loadGeminiKeyPools } from "../../common/gemini/gemini-key-pools";
import { normalizeSceneObjects, WhiteboardSceneJson } from "./whiteboard-scene";

const VISION_PROMPT = `You are a layout analyzer for whiteboard/infographic images.

Analyze the image and detect EVERY visible object: titles, text blocks, images, icons, arrows, diagrams, and shapes.

Return ONLY a single valid JSON object matching this schema exactly:
{
  "objects": [
    {
      "id": "string (unique slug, snake_case)",
      "type": "text | image | icon | arrow | shape | other",
      "bbox": [x1, y1, x2, y2],
      "order": number
    }
  ]
}

Rules:
- bbox values are integer pixel coordinates of the bounding box: top-left (x1,y1) and bottom-right (x2,y2)
- order is the natural reading order starting at 1
- id must be unique; use descriptive slugs like "title_1", "lion_image", "arrow_2"
- Include every visible distinct element; do not skip small icons or arrows
- Return JSON only — no markdown, no explanation`;

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

@Injectable()
export class WhiteboardVisionService {
  private readonly logger = new Logger(WhiteboardVisionService.name);
  private readonly apiKeys: string[];
  private keyIndex = 0;

  constructor(private readonly config: ConfigService) {
    const pools = loadGeminiKeyPools(this.config);
    this.apiKeys = pools.normal.length > 0 ? pools.normal : pools.vip;
  }

  async analyze(sourceImagePath: string): Promise<{
    sceneJson: WhiteboardSceneJson;
    imageWidth: number;
    imageHeight: number;
  }> {
    if (this.apiKeys.length === 0) {
      throw new BadRequestException(
        `Gemini API key not configured. Set ${geminiKeyPoolEnvHint("normal")} in .env`,
      );
    }

    const modelName =
      this.config.get<string>("WHITEBOARD_GEMINI_MODEL")?.trim() || "gemini-2.5-flash";

    const ext = extname(sourceImagePath).toLowerCase();
    const mimeType = MIME_MAP[ext] ?? "image/png";
    const imageData = readFileSync(sourceImagePath);
    const base64Image = imageData.toString("base64");

    // Get image dimensions using a lightweight approach
    const { imageWidth, imageHeight } = this.readImageDimensions(imageData, mimeType);

    let lastError: unknown;
    const maxAttempts = Math.max(this.apiKeys.length, 2);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const genAI = new GoogleGenerativeAI(this.nextKey());
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            maxOutputTokens: 8_192,
          },
        });

        const result = await model.generateContent([
          { text: VISION_PROMPT },
          {
            inlineData: {
              mimeType,
              data: base64Image,
            },
          },
        ]);

        const raw = result.response.text() ?? "";
        const sceneJson = this.parseAndValidate(raw, imageWidth, imageHeight);
        return { sceneJson, imageWidth, imageHeight };
      } catch (error: any) {
        lastError = error;
        const status = error?.status ?? error?.httpStatusCode ?? 0;
        const retryable = status === 429 || status === 500 || status === 503;
        if (retryable && attempt < maxAttempts - 1) {
          this.logger.warn(`Gemini vision attempt ${attempt + 1} failed (${status}), retrying…`);
          continue;
        }
        break;
      }
    }

    const message = lastError instanceof Error ? lastError.message : "Gemini vision failed";
    this.logger.error(`Whiteboard vision analysis failed: ${message}`);
    throw new BadGatewayException(`Vision analysis failed: ${message}`);
  }

  private parseAndValidate(raw: string, imageWidth: number, imageHeight: number): WhiteboardSceneJson {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new BadGatewayException("Gemini returned invalid JSON for vision analysis");
    }

    const input = parsed as Record<string, unknown>;
    const objects = normalizeSceneObjects(input.objects, imageWidth, imageHeight);
    if (objects.length === 0) {
      throw new BadGatewayException("Gemini vision returned no usable objects");
    }

    return { imageWidth, imageHeight, objects };
  }

  private nextKey(): string {
    const key = this.apiKeys[this.keyIndex];
    this.keyIndex = (this.keyIndex + 1) % this.apiKeys.length;
    return key;
  }

  /**
   * Read image dimensions from raw bytes without an external lib.
   * Supports PNG and JPEG. Falls back to 1280x720 if parsing fails.
   */
  private readImageDimensions(buf: Buffer, mimeType: string): { imageWidth: number; imageHeight: number } {
    try {
      if (mimeType === "image/png") {
        // PNG: IHDR chunk starts at byte 16, width at 16-19, height at 20-23
        if (buf.length >= 24) {
          const width = buf.readUInt32BE(16);
          const height = buf.readUInt32BE(20);
          if (width > 0 && height > 0) return { imageWidth: width, imageHeight: height };
        }
      } else if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
        // JPEG: scan for SOF0/SOF2 marker (0xFFC0 / 0xFFC2)
        let i = 2;
        while (i < buf.length - 8) {
          if (buf[i] !== 0xff) break;
          const marker = buf[i + 1];
          const segLen = buf.readUInt16BE(i + 2);
          if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
            const height = buf.readUInt16BE(i + 5);
            const width = buf.readUInt16BE(i + 7);
            if (width > 0 && height > 0) return { imageWidth: width, imageHeight: height };
          }
          i += 2 + segLen;
        }
      } else if (mimeType === "image/webp") {
        // WebP: "RIFF....WEBPVP8 " — width at byte 26-27, height at 28-29 (little-endian, mask 0x3FFF)
        if (buf.length >= 30 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") {
          const width = (buf.readUInt16LE(26) & 0x3fff) + 1;
          const height = (buf.readUInt16LE(28) & 0x3fff) + 1;
          if (width > 0 && height > 0) return { imageWidth: width, imageHeight: height };
        }
      }
    } catch {
      // fall through
    }
    this.logger.warn("Could not parse image dimensions, defaulting to 1280x720");
    return { imageWidth: 1280, imageHeight: 720 };
  }
}
