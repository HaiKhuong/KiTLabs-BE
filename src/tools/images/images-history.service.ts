import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { Repository } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { GenerateStudioImageDto } from "./dto/generate-studio-image.dto";
import { ImageHistory } from "./image-history.entity";
import { STUDIO_IMAGE_FILENAME } from "../videos/video-image.constants";

@Injectable()
export class ImagesHistoryService {
  private readonly logger = new Logger(ImagesHistoryService.name);

  constructor(
    @InjectRepository(ImageHistory, "tool")
    private readonly imageHistoryRepository: Repository<ImageHistory>,
  ) {}

  private buildDisplayName(prompt: string): string {
    const text = prompt.trim();
    return text.length > 80 ? `${text.slice(0, 77).trim()}...` : text;
  }

  async createPending(jobId: string, dto: GenerateStudioImageDto): Promise<ImageHistory> {
    const prompt = dto.prompt.trim();
    const history = this.imageHistoryRepository.create({
      id: jobId,
      userId: dto.userId.trim(),
      prompt,
      displayName: this.buildDisplayName(prompt),
      negativePrompt: dto.negativePrompt?.trim() || null,
      style: (dto.style ?? "anime").trim() || "anime",
      aspectRatio: (dto.aspectRatio ?? "9:16").trim() || "9:16",
      model: (dto.model ?? "flux").trim() || "flux",
      numInferenceSteps: dto.numInferenceSteps ?? null,
      seed: dto.seed ?? null,
      status: QueueJobStatus.RUNNING,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
    });
    return this.imageHistoryRepository.save(history);
  }

  async markCompleted(
    jobId: string,
    resultPath: string,
    geminiData?: {
      promptSent?: string;
      negativeSent?: string | null;
      enrichedPrompt?: string;
      geminiAnalysis?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await this.imageHistoryRepository
      .createQueryBuilder()
      .update(ImageHistory)
      .set({
        status: QueueJobStatus.COMPLETED,
        resultPath: resultPath.replaceAll("\\", "/"),
        resultFileName: STUDIO_IMAGE_FILENAME,
        errorMessage: null,
        promptSent: geminiData?.promptSent ?? null,
        negativeSent: geminiData?.negativeSent ?? null,
        enrichedPrompt: geminiData?.enrichedPrompt ?? null,
        geminiAnalysis: (geminiData?.geminiAnalysis ?? null) as any,
      })
      .where("id = :id", { id: jobId })
      .execute();
  }

  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.imageHistoryRepository.update(
      { id: jobId },
      {
        status: QueueJobStatus.FAILED,
        errorMessage: errorMessage.trim() || "Image generation failed",
      },
    );
  }

  async getHistory(
    userId: string,
    options?: { page?: number; limit?: number },
  ): Promise<{ items: ImageHistory[]; total: number; page: number; limit: number; hasMore: boolean }> {
    const page = Math.max(1, Number(options?.page ?? 1) || 1);
    const limit = Math.min(50, Math.max(1, Number(options?.limit ?? 20) || 20));
    const [items, total] = await this.imageHistoryRepository.findAndCount({
      where: { userId },
      order: { createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    };
  }

  async getById(id: string): Promise<ImageHistory | null> {
    return this.imageHistoryRepository.findOne({ where: { id } });
  }

  async deleteHistory(userId: string, id: string): Promise<void> {
    const row = await this.imageHistoryRepository.findOne({ where: { id, userId } });
    if (!row) {
      throw new NotFoundException("Job not found");
    }

    if (row.resultPath) {
      try {
        const abs = isAbsolute(row.resultPath) ? row.resultPath : resolve(process.cwd(), row.resultPath);
        if (existsSync(abs)) {
          await unlink(abs);
        }
      } catch (err) {
        this.logger.warn(
          `Could not delete image file for history ${id}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    await this.imageHistoryRepository.delete({ id, userId });
  }

  async deleteAllHistory(userId: string): Promise<{ deleted: number }> {
    const rows = await this.imageHistoryRepository.find({ where: { userId } });
    for (const row of rows) {
      await this.deleteHistory(userId, row.id);
    }
    return { deleted: rows.length };
  }

  mapHistoryForClient(row: ImageHistory) {
    const imageUrl =
      row.status === QueueJobStatus.COMPLETED && row.id
        ? `/api/tools/images/${encodeURIComponent(row.userId)}/${encodeURIComponent(row.id)}/${STUDIO_IMAGE_FILENAME}`
        : null;
    return {
      id: row.id,
      name: row.displayName,
      detail: `${row.aspectRatio} · ${row.style}`,
      prompt: row.prompt,
      style: row.style,
      aspectRatio: row.aspectRatio,
      model: row.model,
      completed: row.status === QueueJobStatus.COMPLETED,
      status: row.status,
      resultFileName: row.resultFileName,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      imageUrl,
      downloadUrl: imageUrl,
      promptSent: row.promptSent,
      negativeSent: row.negativeSent,
      enrichedPrompt: row.enrichedPrompt,
      geminiAnalysis: row.geminiAnalysis,
    };
  }
}
