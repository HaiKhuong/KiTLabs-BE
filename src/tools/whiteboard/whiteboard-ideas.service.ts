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
  WhiteboardIdeaStoryboardRow,
} from "./whiteboard-idea-history.entity";

export type WhiteboardIdeaStoryboard = WhiteboardIdeaStoryboardRow;
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
    return [
      "You are an expert researcher, fact-checker, documentary writer, and educational storyboard designer.",
      "Your task is to create a complete storyboard for a Hand Writer educational video.",
      `Topic:\n${idea}`,
      "PRIMARY GOAL",
      "Create a comprehensive educational documentary. Do NOT summarize. Explain thoroughly and logically.",
      "Generate as many scenes as necessary. Each Scene focuses on ONE major idea.",
      "Within each Scene, split narration into multiple Storyboards.",
      "Each Storyboard = ONE continuous voice narration synchronized with its visual elements.",
      "FACTUAL ACCURACY",
      "Accuracy is highest priority. Every statement must be well-established knowledge.",
      "Never fabricate: facts, statistics, quotations, dates, historical events, scientific discoveries, names.",
      "If multiple theories exist: explain major viewpoints; distinguish facts from hypotheses; never present speculation as fact.",
      "If evidence is uncertain, say experts have not reached a consensus.",
      "NARRATION",
      "Write natural Vietnamese in documentary style. Explain clearly and progressively.",
      "Include when useful: background, origin, mechanism, causes, consequences, comparisons, examples, misconceptions, interesting facts, current scientific understanding.",
      "Commentary is ok but must not alter factual meaning. No clickbait. No artificial drama.",
      "Split into logical Storyboards; each has one complete idea. Avoid overly long paragraphs.",
      "STORYBOARD",
      "Storyboard is NOT an image prompt. It is a visual plan for Hand Writer animation.",
      "For every Storyboard, describe all visual elements that appear while that narration is spoken.",
      "Think like a documentary director designing educational visuals.",
      "Visual elements may include: Illustration, Realistic image, Historical image, Scientific diagram, Character, Object, Animal, Plant, Landmark, Building, Icon, Symbol, Title, Keyword, Important text, Number, Statistic, Timeline, Flowchart, Table, Comparison, Formula, Map, Arrow, Label, Callout, Highlight, Warning symbol, Question mark, Magnifying glass, Light bulb, Cross-section, Before/After comparison, or any educational visual that improves understanding.",
      "Whenever narration introduces a new concept, add the appropriate visual element.",
      "VISUAL RULES",
      "Describe WHAT should appear.",
      "Do NOT describe: camera movement, animation, transitions, screen coordinates, layout positions, timing.",
      "Do NOT describe a complete finished image. Describe independent visual elements that can appear progressively.",
      "Visuals should help viewers immediately understand the narration. Avoid unnecessary decoration.",
      "A Storyboard should contain only enough narration to match one group of visuals.",
      "If narration introduces a new concept, comparison, mechanism, object, timeline, or conclusion, start a new Storyboard.",
      "Prefer more Storyboards with shorter narration over fewer with long narration.",
      "GOOD EXAMPLE",
      'Voice: "Kim cương là vật liệu tự nhiên cứng nhất trên Trái Đất."',
      "Visuals:",
      '- Large sparkling diamond illustration.',
      '- Bold text: "Độ cứng vượt trội".',
      '- Arrow pointing to "Cứng nhất trong các vật liệu tự nhiên".',
      "- Hammer icon striking the diamond.",
      "- Earth icon.",
      "- Highlight around the diamond.",
      "OUTPUT",
      "Return ONLY valid JSON:",
      '{"title":"Video title","scenes":[{"title":"Scene title","storyboards":[{"voice":"Narration spoken during this storyboard.","visuals":["Visual element 1","Visual element 2","Visual element 3"]}]}]}',
    ].join("\n");
  }

  private parseAndValidate(raw: string): WhiteboardIdeaScene[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.stripCodeFence(raw));
    } catch {
      throw new BadGatewayException("Gemini returned invalid JSON");
    }

    const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const list = Array.isArray(root?.scenes) ? root!.scenes : null;
    if (!list || list.length === 0) {
      throw new BadGatewayException("Gemini JSON missing scenes[]");
    }

    const scenes: WhiteboardIdeaScene[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const title = String(row.title ?? "").trim() || `Scene ${scenes.length + 1}`;
      const storyboardRaw = Array.isArray(row.storyboards) ? row.storyboards : [];
      const storyboards: WhiteboardIdeaStoryboard[] = [];

      for (const sb of storyboardRaw) {
        if (!sb || typeof sb !== "object") continue;
        const board = sb as Record<string, unknown>;
        const voice = String(board.voice ?? board.narration ?? "").trim();
        const visuals = this.parseVisuals(board.visuals ?? board.imgDesc ?? board.imgDescription);
        if (!voice || visuals.length === 0) continue;
        storyboards.push({ voice, visuals });
      }

      if (storyboards.length === 0) continue;
      scenes.push({ title, storyboards });
    }

    if (scenes.length === 0) {
      throw new BadGatewayException("Gemini scenes missing storyboards with voice/visuals");
    }

    return scenes;
  }

  private parseVisuals(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw.map((item) => String(item ?? "").trim()).filter(Boolean);
    }
    if (typeof raw === "string") {
      const text = raw.trim();
      return text ? [text] : [];
    }
    return [];
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
