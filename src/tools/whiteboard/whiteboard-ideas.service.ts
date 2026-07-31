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
      "FACTUAL ACCURACY",
      "Accuracy is highest priority. Every statement must be well-established knowledge.",
      "Never fabricate: facts, statistics, quotations, dates, historical events, scientific discoveries, names.",
      "If multiple theories exist: explain major viewpoints; distinguish facts from hypotheses; never present speculation as fact.",
      "If evidence is uncertain, say experts have not reached a consensus.",
      "NARRATION",
      "Write natural Vietnamese in documentary style. Explain clearly and progressively.",
      "Include when useful: background, origin, mechanism, causes, consequences, comparisons, examples, misconceptions, interesting facts, current scientific understanding.",
      "Commentary is ok but must not alter factual meaning. No clickbait. No artificial drama.",
      "SCENE RULES",
      "A Scene = ONE major topic.",
      "Each Scene MUST contain min 5 and max 9 Storyboards.",
      "If a topic is too large, start a new Scene instead of exceeding 9 Storyboards. Total Scenes is unlimited.",
      "STORYBOARD RULES",
      "Each Storyboard = ONE continuous narration synchronized with its visuals.",
      "Each Storyboard MUST: explain only ONE idea; contain no more than TWO sentences; be easy to understand; naturally connect to previous/next Storyboard.",
      "When narration introduces a new concept, start a new Storyboard. Prefer shorter Storyboards.",
      "VISUAL STORYBOARD",
      "Storyboard is NOT an image prompt. It is a visual plan for Hand Writer animation.",
      "For every Storyboard, describe all visual elements that appear while that narration is spoken.",
      "Think like a documentary director designing educational visuals.",
      "Visual elements may include: Illustration, Realistic image, Historical artwork, Scientific diagram, Character, Animal, Plant, Object, Landmark, Building, Icon, Symbol, Title, Keyword, Important text, Number, Statistic, Timeline, Flowchart, Table, Comparison, Formula, Map, Arrow, Label, Callout, Highlight, Warning symbol, Question mark, Magnifying glass, Light bulb, Cross-section, Before/After comparison, or any educational visual that improves understanding.",
      "Whenever narration introduces a new concept, include the corresponding visual element.",
      "VISUAL RULES",
      "Describe WHAT should appear.",
      "Do NOT describe: camera movement, animation, transitions, timing, screen coordinates, layout positions.",
      "Do NOT describe one complete finished picture. Describe independent visual elements that can progressively appear during Hand Writer animation.",
      "Avoid unnecessary decoration. Visuals must directly support the narration.",
      "VISUAL CONTINUITY",
      "Within the SAME Scene, visual elements should evolve naturally.",
      "Do NOT repeatedly introduce the same main illustration unless required for a new explanation.",
      "Assume previously introduced visual elements remain visible throughout the Scene unless replaced.",
      "When creating a new Storyboard: reuse existing visuals conceptually instead of describing them again; introduce only NEW visuals needed for the current narration; focus on expanding or explaining existing visuals.",
      "Avoid repeating the same diamond/Earth/character/map/building/animal unless they significantly change or serve a different educational purpose.",
      "Instead add new elements: labels, arrows, comparison, statistics, annotations, diagrams, highlighted regions, cross-sections, formulas, callouts, explanatory icons.",
      "Every Storyboard must introduce at least one NEW visual element. Minimize visual repetition.",
      "Introduce a visual element only once per Scene when possible. After that, assume it already exists on the canvas.",
      "Later Storyboards should only describe NEW elements to add, modify, annotate, compare, or emphasize.",
      "Do NOT recreate or redescribe existing visual elements unless a substantial visual change is required.",
      "VISUAL LANGUAGE",
      "Use Vietnamese for all visual descriptions whenever possible. Write visuals as clear, concise Vietnamese phrases.",
      "Every visual string MUST start with exactly one fixed prefix from this list:",
      "Hình minh họa: | Biểu tượng: | Văn bản: | Sơ đồ: | Biểu đồ: | Bản đồ: | Mũi tên: | Bảng so sánh: | Hiệu ứng nhấn mạnh:",
      'Examples: "Hình minh họa: Viên kim cương lấp lánh"; "Biểu tượng: Trái Đất"; "Mũi tên: Chỉ sang phải"; "Văn bản: Độ cứng vượt trội"; "Sơ đồ: Cấu trúc nguyên tử carbon"; "Biểu tượng: Kính lúp"; "Biểu đồ: Cột so sánh"; "Bản đồ: Thế giới"; "Hình minh họa: Mạng tinh thể 3D"; "Hiệu ứng nhấn mạnh: Vùng highlight quanh kim cương".',
      "Avoid unnecessary English words.",
      "Only use internationally recognized scientific terms, symbols, formulas, chemical names, or proper nouns when there is no common Vietnamese equivalent (e.g. sp3, DNA, CO₂, H₂O, pH, AI, NASA).",
      "GOOD EXAMPLE",
      'Voice: "Kim cương là vật liệu tự nhiên cứng nhất trên Trái Đất."',
      "Visuals:",
      "- Hình minh họa: Viên kim cương lấp lánh.",
      '- Văn bản: Độ cứng vượt trội.',
      '- Mũi tên: Chỉ tới "Cứng nhất trong các vật liệu tự nhiên".',
      "- Biểu tượng: Búa đập vào kim cương.",
      "- Biểu tượng: Trái Đất.",
      "- Hiệu ứng nhấn mạnh: Vùng highlight quanh viên kim cương.",
      "OUTPUT",
      "Return ONLY valid JSON:",
      '{"title":"Video title","scenes":[{"title":"Scene title","storyboards":[{"voice":"Maximum two sentences.","visuals":["Visual element 1","Visual element 2","Visual element 3"]}]}]}',
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
