import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { existsSync } from "fs";
import { basename, extname, join, resolve, sep } from "path";
import { Repository } from "typeorm";

import { CreditHistory } from "../credits/credit-history.entity";
import { LogsService } from "../logs/logs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { User } from "../users/user.entity";
import { NotificationType, QueueJobStatus } from "../../common/enums/domain.enums";
import { CreateTranslateJobDto } from "./dto/create-translate-job.dto";
import { TranslateHistory } from "./translate-history.entity";

export const TRANSLATE_QUEUE_NAME = "video-translate";
export type TranslateArtifactType = "zh" | "vi" | "audio" | "video";
const STEP_TO_FUNCTION_CODE: Record<number, string> = {
  1: "GET_SUBTITLES_ORIGINAL",
  2: "TRANSLATE_BY_AI",
  3: "GENERATE_VOICE_TTS",
  4: "MERGE_VIDEO_WITH_VOICE_TTS",
  5: "CREATE_SUBTITLE_TO_ASS",
  6: "MERGE_VIDEO_WITH_SUBTITLE_AND_LOGO",
};

@Injectable()
export class TranslateService {
  constructor(
    @InjectQueue(TRANSLATE_QUEUE_NAME)
    private readonly translateQueue: Queue,
    @InjectRepository(TranslateHistory, "tool")
    private readonly translateRepository: Repository<TranslateHistory>,
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
    @InjectRepository(CreditHistory, "tool")
    private readonly creditHistoryRepository: Repository<CreditHistory>,
    private readonly logsService: LogsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async enqueue(dto: CreateTranslateJobDto): Promise<TranslateHistory> {
    if (!dto.userId) {
      throw new BadRequestException("userId is required");
    }
    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const estimatedCost = dto.estimatedCost ?? 1;
    const availableCredit = Number(user.credit);
    if (availableCredit < estimatedCost) {
      throw new BadRequestException("Insufficient credit for translation");
    }

    const normalizedSteps = this.normalizeSteps(dto.stepNbr);
    const functionUsed = normalizedSteps.map((step) => STEP_TO_FUNCTION_CODE[step]);

    const history = this.translateRepository.create({
      userId: dto.userId,
      stepNbr: normalizedSteps,
      functionUsed,
      engineConfig: dto.engineConfig ? (dto.engineConfig as any) : null,
      status: QueueJobStatus.PENDING,
      cost: estimatedCost.toFixed(2),
      queueJobId: null,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
    });
    const created = await this.translateRepository.save(history);

    const queueJob = await this.translateQueue.add(
      TRANSLATE_QUEUE_NAME,
      { translateHistoryId: created.id },
      { attempts: 2, removeOnComplete: true, removeOnFail: 50 },
    );

    created.queueJobId = queueJob.id ? String(queueJob.id) : null;
    const saved = await this.translateRepository.save(created);

    await this.logsService.createLog({
      userId: user.id,
      action: "translate.queued",
      payload: {
        translateHistoryId: saved.id,
        queueJobId: saved.queueJobId,
        stepNbr: saved.stepNbr,
        functionUsed: saved.functionUsed,
      },
      ip: user.ip,
    });
    return saved;
  }

  async processStarted(translateHistoryId: string): Promise<void> {
    await this.translateRepository.update({ id: translateHistoryId }, { status: QueueJobStatus.RUNNING });
  }

  async processCompleted(translateHistoryId: string, resultPath: string): Promise<void> {
    const history = await this.translateRepository.findOne({
      where: { id: translateHistoryId },
    });
    if (!history) {
      return;
    }

    history.status = QueueJobStatus.COMPLETED;
    history.resultPath = resultPath;
    history.resultFileName = basename(resultPath);
    history.errorMessage = null;
    await this.translateRepository.save(history);

    const user = await this.userRepository.findOne({ where: { id: history.userId } });
    if (user) {
      const current = Number(user.credit);
      const next = Math.max(current - Number(history.cost), 0);
      user.credit = next.toFixed(2);
      await this.userRepository.save(user);

      await this.creditHistoryRepository.save(
        this.creditHistoryRepository.create({
          userId: user.id,
          amount: (-Number(history.cost)).toFixed(2),
          balance: user.credit,
          reason: "translate_video",
          metadata: { translateHistoryId: history.id },
        }),
      );

      await this.notificationsService.push({
        userId: user.id,
        title: "Video translation completed",
        message: `Job ${history.id} is completed.`,
        type: NotificationType.SUCCESS,
      });
    }
  }

  async processFailed(translateHistoryId: string, errorMessage: string): Promise<void> {
    await this.translateRepository.update(
      { id: translateHistoryId },
      {
        status: QueueJobStatus.FAILED,
        errorMessage,
      },
    );
  }

  async getHistory(userId: string): Promise<TranslateHistory[]> {
    return this.translateRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }

  async getById(id: string): Promise<TranslateHistory | null> {
    return this.translateRepository.findOne({ where: { id } });
  }

  parseArtifactType(type?: string): TranslateArtifactType {
    if (type === "zh" || type === "vi" || type === "audio" || type === "video") {
      return type;
    }
    throw new BadRequestException("type must be one of: zh, vi, audio, video");
  }

  resolveArtifact(resultPath: string, type: TranslateArtifactType): { absolutePath: string; contentType: string } {
    const normalizedResultPath = this.normalizeResultPath(resultPath);
    const workspaceDir = this.resolveWorkspaceDir(normalizedResultPath);
    const workName = basename(workspaceDir);

    let absolutePath = normalizedResultPath;
    let contentType = "video/mp4";

    if (type === "zh" || type === "vi") {
      const preferredSubtitlePath = join(workspaceDir, "subtitles", `${workName}.${type}.srt`);
      const legacySubtitlePath = join(workspaceDir, "subtitles", `${type}.srt`);
      absolutePath = existsSync(preferredSubtitlePath) ? preferredSubtitlePath : legacySubtitlePath;
      contentType = "text/plain; charset=utf-8";
    } else if (type === "audio") {
      absolutePath = join(workspaceDir, "videos", `${workName}_voice.wav`);
      contentType = "audio/wav";
    } else if (extname(normalizedResultPath).toLowerCase() !== ".mp4") {
      absolutePath = join(workspaceDir, "videos", `${workName}_vs_tm.mp4`);
    }

    if (!existsSync(absolutePath)) {
      throw new NotFoundException(`Artifact not found for type ${type}`);
    }

    return { absolutePath, contentType };
  }

  private normalizeSteps(stepNbr: number[]): number[] {
    const normalized = [...new Set(stepNbr)].sort((a, b) => a - b);
    if (normalized.length === 0) {
      throw new BadRequestException("stepNbr must not be empty");
    }

    for (let i = 0; i < normalized.length; i += 1) {
      const step = normalized[i];
      if (!(step in STEP_TO_FUNCTION_CODE)) {
        throw new BadRequestException("stepNbr only supports values from 1 to 6");
      }
      if (i > 0 && step !== normalized[i - 1] + 1) {
        throw new BadRequestException("stepNbr must be a continuous range (example: [1,2,3] or [3,4])");
      }
    }
    return normalized;
  }

  private normalizeResultPath(resultPath: string): string {
    if (!resultPath || resultPath.trim().length === 0) {
      throw new BadRequestException("resultPath is required");
    }

    const normalized = resolve(resultPath.trim());
    if (!normalized.split(sep).includes("workspace")) {
      throw new BadRequestException("resultPath must point to translate workspace");
    }

    return normalized;
  }

  private resolveWorkspaceDir(normalizedResultPath: string): string {
    const normalizedSlashPath = normalizedResultPath.replaceAll("\\", "/");
    const matched = normalizedSlashPath.match(/^(.*\/workspace\/[^/]+)(?:\/.*)?$/);

    if (!matched || !matched[1]) {
      throw new BadRequestException("resultPath must contain workspace/<workName>");
    }

    return matched[1].replaceAll("/", sep);
  }
}
