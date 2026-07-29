import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { GenerateVeoVideoDto, VeoModel } from "./dto/generate-veo-video.dto";
import { VideoHistory } from "./video-history.entity";

const DEFAULT_MODEL: VeoModel = "veo-3.1-generate-preview";

@Injectable()
export class VideoHistoryService {
  constructor(
    @InjectRepository(VideoHistory, "tool")
    private readonly repository: Repository<VideoHistory>,
  ) {}

  async createPending(dto: GenerateVeoVideoDto, resolvedModel: VeoModel): Promise<VideoHistory> {
    const prompt = dto.prompt.trim();
    return this.repository.save(
      this.repository.create({
        userId: dto.userId.trim(),
        prompt,
        displayName: this.buildDisplayName(prompt),
        model: resolvedModel || DEFAULT_MODEL,
        aspectRatio: dto.aspectRatio ?? "16:9",
        durationSeconds: dto.durationSeconds ?? 8,
        resolution: dto.resolution ?? "720p",
        personGeneration: dto.personGeneration ?? null,
        seed: dto.seed == null ? null : String(dto.seed),
        apiKeyTier: dto.apiKeyTier ?? "normal",
        operationName: null,
        status: QueueJobStatus.PENDING,
        geminiVideoUri: null,
        resultMimeType: null,
        errorMessage: null,
      }),
    );
  }

  async markRunning(id: string, operationName: string, apiKeyTier: string): Promise<void> {
    await this.repository.update(
      { id },
      {
        operationName,
        apiKeyTier,
        status: QueueJobStatus.RUNNING,
        errorMessage: null,
      },
    );
  }

  async markCompletedByOperation(operationName: string, result: { uri?: string; mimeType?: string }): Promise<void> {
    await this.repository.update(
      { operationName },
      {
        status: QueueJobStatus.COMPLETED,
        geminiVideoUri: result.uri ?? null,
        resultMimeType: result.mimeType ?? "video/mp4",
        errorMessage: null,
      },
    );
  }

  async markFailedByOperation(operationName: string, error: unknown): Promise<void> {
    await this.repository.update(
      { operationName },
      {
        status: QueueJobStatus.FAILED,
        errorMessage: this.errorMessage(error),
      },
    );
  }

  async markFailed(id: string, error: unknown): Promise<void> {
    await this.repository.update(
      { id },
      {
        status: QueueJobStatus.FAILED,
        errorMessage: this.errorMessage(error),
      },
    );
  }

  async getHistory(
    userId: string,
    options?: { page?: number; limit?: number },
  ): Promise<{ items: VideoHistory[]; total: number; page: number; limit: number; hasMore: boolean }> {
    const page = Math.max(1, Number(options?.page ?? 1) || 1);
    const limit = Math.min(50, Math.max(1, Number(options?.limit ?? 20) || 20));
    const [items, total] = await this.repository.findAndCount({
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

  async getRunningOperations(): Promise<Array<{ operationName: string; apiKeyTier: string }>> {
    const rows = await this.repository.find({
      where: { status: QueueJobStatus.RUNNING },
      select: { operationName: true, apiKeyTier: true },
    });
    return rows
      .filter((row): row is VideoHistory & { operationName: string } => Boolean(row.operationName))
      .map((row) => ({
        operationName: row.operationName,
        apiKeyTier: row.apiKeyTier,
      }));
  }

  async deleteHistory(userId: string, id: string): Promise<void> {
    const result = await this.repository.delete({ id, userId });
    if (!result.affected) {
      throw new NotFoundException("Video history not found");
    }
  }

  async deleteAllHistory(userId: string): Promise<{ deleted: number }> {
    const result = await this.repository.delete({ userId });
    return { deleted: result.affected ?? 0 };
  }

  mapForClient(row: VideoHistory) {
    const downloadUrl =
      row.status === QueueJobStatus.COMPLETED && row.operationName
        ? this.buildDownloadUrl(row.operationName, row.apiKeyTier)
        : null;
    return {
      id: row.id,
      userId: row.userId,
      name: row.displayName,
      prompt: row.prompt,
      model: row.model,
      aspectRatio: row.aspectRatio,
      durationSeconds: row.durationSeconds,
      resolution: row.resolution,
      personGeneration: row.personGeneration,
      seed: row.seed == null ? null : Number(row.seed),
      apiKeyTier: row.apiKeyTier,
      operationName: row.operationName,
      status: row.status,
      completed: row.status === QueueJobStatus.COMPLETED,
      geminiVideoUri: row.geminiVideoUri,
      resultMimeType: row.resultMimeType,
      downloadUrl,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private buildDisplayName(prompt: string): string {
    return prompt.length > 80 ? `${prompt.slice(0, 77).trim()}...` : prompt;
  }

  private buildDownloadUrl(operationName: string, apiKeyTier: string): string {
    const query = new URLSearchParams({ operationName, apiKeyTier });
    return `/api/tools/videos/veo/operations/video?${query.toString()}`;
  }

  private errorMessage(error: unknown): string {
    if (typeof error === "string") return error.trim() || "Veo generation failed";
    if (error && typeof error === "object") {
      const value = error as { message?: unknown; error?: { message?: unknown } };
      if (typeof value.error?.message === "string") return value.error.message;
      if (typeof value.message === "string") return value.message;
      try {
        return JSON.stringify(error);
      } catch {
        return "Veo generation failed";
      }
    }
    return "Veo generation failed";
  }
}
