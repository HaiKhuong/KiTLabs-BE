import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Repository } from "typeorm";

import { geminiKeyPoolEnvHint, loadGeminiKeyPools } from "../../common/gemini/gemini-key-pools";
import {
  WhiteboardIdeaHistory,
  WhiteboardIdeaSceneRow,
} from "./whiteboard-idea-history.entity";

export type WhiteboardIdeaScene = WhiteboardIdeaSceneRow;

export type WhiteboardIdeasResult = {
  id: string;
  title: string;
  idea: string;
  model: string;
  scenes: WhiteboardIdeaScene[];
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class WhiteboardIdeasService {
  private readonly logger = new Logger(WhiteboardIdeasService.name);
  private readonly apiKeys: string[];
  private keyIndex = 0;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(WhiteboardIdeaHistory, "tool")
    private readonly repository: Repository<WhiteboardIdeaHistory>,
  ) {
    const pools = loadGeminiKeyPools(this.config);
    this.apiKeys = pools.normal.length > 0 ? pools.normal : pools.vip;
  }

  async generateAndSave(userIdInput: string, ideaInput: string): Promise<WhiteboardIdeasResult> {
    const userId = userIdInput?.trim();
    if (!userId) throw new BadRequestException("userId is required");

    const generated = await this.generate(ideaInput);
    const row = this.repository.create({
      userId,
      title: generated.title.slice(0, 255),
      idea: generated.idea,
      model: generated.model,
      scenes: generated.scenes,
    });
    const saved = await this.repository.save(row);
    return this.mapForClient(saved);
  }

  async listHistory(
    userId: string,
    page = 1,
    limit = 20,
    search?: string,
  ): Promise<{
    items: WhiteboardIdeasResult[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const take = Math.min(Math.max(1, Math.trunc(limit) || 20), 50);
    const currentPage = Math.max(1, Math.trunc(page) || 1);
    const skip = (currentPage - 1) * take;
    const keyword = search?.trim() ?? "";

    const qb = this.repository
      .createQueryBuilder("h")
      .where("h.user_id = :userId", { userId: userId.trim() });

    if (keyword) {
      qb.andWhere("(h.title ILIKE :keyword OR h.idea ILIKE :keyword)", {
        keyword: `%${keyword}%`,
      });
    }

    const [rows, total] = await qb
      .orderBy("h.created_at", "DESC")
      .take(take)
      .skip(skip)
      .getManyAndCount();

    return {
      items: rows.map((row) => this.mapForClient(row)),
      total,
      page: currentPage,
      limit: take,
      hasMore: skip + rows.length < total,
    };
  }

  async getOwnedById(id: string, userId: string): Promise<WhiteboardIdeasResult> {
    const row = await this.repository.findOne({ where: { id, userId: userId.trim() } });
    if (!row) throw new NotFoundException("Idea history not found");
    return this.mapForClient(row);
  }

  async deleteHistory(id: string, userId: string): Promise<{ deleted: boolean; id: string }> {
    const row = await this.repository.findOne({ where: { id, userId: userId.trim() } });
    if (!row) throw new NotFoundException("Idea history not found");
    await this.repository.delete({ id, userId: userId.trim() });
    return { deleted: true, id };
  }

  async deleteAllHistory(userId: string): Promise<{ deleted: number }> {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const result = await this.repository.delete({ userId: userId.trim() });
    return { deleted: result.affected ?? 0 };
  }

  mapForClient(row: WhiteboardIdeaHistory): WhiteboardIdeasResult {
    return {
      id: row.id,
      title: row.title,
      idea: row.idea,
      model: row.model,
      scenes: Array.isArray(row.scenes) ? row.scenes : [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async generate(ideaInput: string): Promise<{
    title: string;
    idea: string;
    model: string;
    scenes: WhiteboardIdeaScene[];
  }> {
    const idea = ideaInput?.trim();
    if (!idea) throw new BadRequestException("idea is required");

    if (this.apiKeys.length === 0) {
      throw new BadRequestException(
        `Gemini API key not configured. Set ${geminiKeyPoolEnvHint("normal")} in .env`,
      );
    }

    const modelName =
      this.config.get<string>("WHITEBOARD_GEMINI_MODEL")?.trim() || "gemini-2.5-flash";
    const prompt = this.buildPrompt(idea);

    let lastError: unknown;
    const maxAttempts = Math.max(this.apiKeys.length, 2);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const genAI = new GoogleGenerativeAI(this.nextKey());
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.4,
            responseMimeType: "application/json",
            maxOutputTokens: 65_536,
          },
        });
        const result = await model.generateContent(prompt);
        const raw = result.response.text() ?? "";
        const scenes = this.parseAndValidate(raw);
        const title = this.readTitle(raw) || this.fallbackTitle(idea);
        return { title, idea, model: modelName, scenes };
      } catch (error: any) {
        lastError = error;
        const status = error?.status ?? error?.httpStatusCode ?? 0;
        const retryable =
          error instanceof BadGatewayException || status === 429 || status === 500 || status === 503;
        if (retryable && attempt < maxAttempts - 1) {
          this.logger.warn(`Whiteboard ideas generation failed (${status || "validation"}), retrying…`);
          continue;
        }
        break;
      }
    }

    const message = lastError instanceof Error ? lastError.message : "Gemini generation failed";
    this.logger.error(`Whiteboard ideas generation failed: ${message}`);
    throw new BadGatewayException(`Không thể tạo ý tưởng bằng Gemini: ${message}`);
  }

  private buildPrompt(idea: string): string {
    return `You are an expert researcher, fact-checker, and documentary script writer.

Your primary objective is to produce highly accurate, comprehensive, and engaging Vietnamese educational content.

The topic is:

${idea}

==================================================
GOAL
==================================================

Generate a complete documentary-style script.

Do NOT summarize.

Cover the topic as comprehensively as possible.

The response should contain enough detail that it can directly become a long-form YouTube narration.

Return ONLY valid JSON.

==================================================
FACTUAL ACCURACY
==================================================

Accuracy is your highest priority.

Every statement must be based on well-established knowledge.

If multiple scientific theories or historical viewpoints exist:

- Present every major viewpoint.
- Explain the supporting evidence.
- Clearly distinguish facts from hypotheses.
- Never present speculation as fact.

Do not invent information.

Do not exaggerate.

Do not fabricate statistics, dates, names, quotations, discoveries, or historical events.

If a number is uncertain, describe it qualitatively instead of making one up.

When evidence is incomplete or debated, explicitly state that experts have not reached a consensus.

==================================================
WRITING STYLE
==================================================

Write in natural Vietnamese.

Sound like an experienced documentary narrator.

Combine factual explanation with thoughtful commentary and interesting observations.

The commentary should:

- help viewers understand the importance of the information
- connect ideas naturally
- make the content more engaging

Never add emotional drama that changes factual meaning.

Do not use clickbait.

Do not intentionally create controversy.

==================================================
CONTENT DEPTH
==================================================

Explain concepts thoroughly.

Whenever appropriate include:

- background
- origin
- history
- scientific explanation
- mechanisms
- causes
- consequences
- examples
- comparisons
- interesting facts
- misconceptions
- current understanding
- unanswered questions

Do not skip important intermediate explanations.

Assume the audience has no prior knowledge.

==================================================
IMAGE DESCRIPTION
==================================================

For every narration segment generate one image description.

The image should clearly visualize the narration.

Image descriptions should:

- describe the main subject
- describe important objects
- describe the environment
- describe important actions
- describe mood if relevant

Do NOT describe:

- camera angle
- animation
- layout
- screen position
- text placement
- transitions

The description should be suitable for AI image generation.

==================================================
SEGMENTING
==================================================

Split the content naturally.

Do NOT target a specific number of scenes.

Create as many segments as necessary to explain the topic properly.

Each segment should focus on only one idea.

Narration length may vary depending on the complexity.

==================================================
OUTPUT FORMAT
==================================================

Return ONLY JSON.

{
  "title": "...",
  "content": [
    {
      "narration": "...",
      "imgDesc": "..."
    }
  ]
}`;
  }

  private parseAndValidate(raw: string): WhiteboardIdeaScene[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.stripCodeFence(raw));
    } catch {
      throw new BadGatewayException("Gemini returned invalid JSON");
    }

    const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const list = Array.isArray(root?.content)
      ? root!.content
      : Array.isArray(root?.scenes)
        ? root!.scenes
        : null;
    if (!list || list.length === 0) {
      throw new BadGatewayException("Gemini JSON missing content[]");
    }

    const scenes: WhiteboardIdeaScene[] = [];
    list.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") return;
      const row = entry as Record<string, unknown>;
      const narration = String(row.narration ?? "").trim();
      const imgDescription = String(
        row.imgDesc ?? row.imgDescription ?? row.imageDescription ?? "",
      ).trim();
      if (!narration || !imgDescription) return;
      scenes.push({
        id: `scene_${index + 1}`,
        order: index + 1,
        narration,
        imgDescription,
      });
    });

    if (scenes.length === 0) {
      throw new BadGatewayException("Gemini content missing narration/imgDesc");
    }

    return scenes;
  }

  private readTitle(raw: string): string {
    try {
      const parsed = JSON.parse(this.stripCodeFence(raw)) as { title?: unknown };
      return typeof parsed.title === "string" ? parsed.title.trim() : "";
    } catch {
      return "";
    }
  }

  private fallbackTitle(idea: string): string {
    const firstLine = idea.split(/\r?\n/)[0]?.trim() || "Whiteboard idea";
    return firstLine.slice(0, 80);
  }

  private stripCodeFence(raw: string): string {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
  }

  private nextKey(): string {
    const key = this.apiKeys[this.keyIndex % this.apiKeys.length];
    this.keyIndex = (this.keyIndex + 1) % this.apiKeys.length;
    return key;
  }
}
