import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import axios from "axios";
import { In, Repository } from "typeorm";

import { LogsService } from "../logs/logs.service";
import { User } from "../users/user.entity";
import { DownloadHistory } from "./download-history.entity";
import { CreateDownloadDto } from "./dto/create-download.dto";
import { DownloadVideosDto } from "./dto/download-videos.dto";
import { ImportVideoListDto } from "./dto/import-video-list.dto";
import { UpdateVideoFilenameDto } from "./dto/update-video-filename.dto";
import { VideoDownload, VideoDownloadStatus } from "./video-download.entity";

const GOPEED_CREATE_TASK = "http://localhost:9999/api/v1/tasks";

@Injectable()
export class DownloadsService {
  constructor(
    @InjectRepository(DownloadHistory, "tool")
    private readonly downloadRepository: Repository<DownloadHistory>,
    @InjectRepository(VideoDownload, "tool")
    private readonly videoDownloadRepository: Repository<VideoDownload>,
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
    private readonly logsService: LogsService,
  ) {}

  async create(dto: CreateDownloadDto): Promise<DownloadHistory> {
    if (!dto.userId) {
      throw new BadRequestException("userId is required");
    }
    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const history = this.downloadRepository.create({
      userId: user.id,
      sourceType: dto.sourceType,
      sourceValue: dto.sourceValue,
      savedPath: dto.savePath ?? null,
      status: "completed",
      message: "Download record created",
    });
    const saved = await this.downloadRepository.save(history);

    await this.logsService.createLog({
      userId: user.id,
      action: "download.created",
      payload: {
        sourceType: dto.sourceType,
        sourceValue: dto.sourceValue,
        savePath: dto.savePath ?? null,
      },
      ip: user.ip,
    });
    return saved;
  }

  async histories(userId: string): Promise<DownloadHistory[]> {
    return this.downloadRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }

  async importVideoList(userId: string, dto: ImportVideoListDto) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const entries = this.parseVideoListTxt(dto.content);
    if (entries.length === 0) {
      throw new BadRequestException("No valid video entries found in content");
    }

    const videos = entries.map((entry) =>
      this.videoDownloadRepository.create({
        userId: user.id,
        orderNumber: entry.orderNumber,
        awemeId: entry.awemeId,
        date: entry.date,
        fileName: entry.fileName,
        videoUrl: entry.videoUrl,
        description: entry.description,
        status: VideoDownloadStatus.PENDING,
      }),
    );

    const saved = await this.videoDownloadRepository.save(videos);

    await this.logsService.createLog({
      userId: user.id,
      action: "video.import",
      payload: { count: saved.length },
      ip: user.ip,
    });

    return { count: saved.length, videos: saved };
  }

  private parseVideoListTxt(content: string) {
    const entries: Array<{
      orderNumber: string;
      awemeId: string;
      date: string;
      fileName: string;
      videoUrl: string;
      description: string;
    }> = [];

    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const parts = trimmed.split("|").map((p) => p.trim());
      if (parts.length < 5) {
        continue;
      }

      const videoUrl = parts[4] || "";
      if (!videoUrl.startsWith("http")) {
        continue;
      }

      const finalUrl = videoUrl.startsWith("http://") ? "https://" + videoUrl.substring(7) : videoUrl;

      entries.push({
        orderNumber: parts[0] || "",
        awemeId: parts[1] || "",
        date: parts[2] || "",
        fileName: parts[3] || `video_${Date.now()}.mp4`,
        videoUrl: finalUrl,
        description: parts[5] || "",
      });
    }

    return entries;
  }

  async getVideoDownloads(userId: string): Promise<VideoDownload[]> {
    return this.videoDownloadRepository.find({
      where: { userId },
      order: { orderNumber: "ASC", createdAt: "DESC" },
    });
  }

  async updateVideoFilename(userId: string, videoId: string, dto: UpdateVideoFilenameDto): Promise<VideoDownload> {
    const video = await this.videoDownloadRepository.findOne({
      where: { id: videoId, userId },
    });

    if (!video) {
      throw new BadRequestException("Video not found");
    }

    video.fileName = dto.fileName;
    return this.videoDownloadRepository.save(video);
  }

  async downloadVideos(userId: string, dto: DownloadVideosDto) {
    const videos = await this.videoDownloadRepository.find({
      where: { id: In(dto.videoIds), userId },
    });

    if (videos.length === 0) {
      throw new BadRequestException("No videos found with provided IDs");
    }

    const results = [];
    for (const video of videos) {
      try {
        const taskId = await this.sendToGopeed(video.videoUrl, video.fileName);
        video.status = VideoDownloadStatus.DOWNLOADING;
        video.gopeedTaskId = taskId;
        await this.videoDownloadRepository.save(video);

        results.push({
          videoId: video.id,
          success: true,
          taskId,
        });
      } catch (error) {
        video.status = VideoDownloadStatus.FAILED;
        video.errorMessage = error instanceof Error ? error.message : "Unknown error";
        await this.videoDownloadRepository.save(video);

        results.push({
          videoId: video.id,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    await this.logsService.createLog({
      userId,
      action: "video.download",
      payload: { videoIds: dto.videoIds, results },
      ip: null,
    });

    return {
      total: videos.length,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  }

  private async sendToGopeed(videoUrl: string, filename: string): Promise<string> {
    const payload = {
      name: filename,
      req: { url: videoUrl },
      opts: { name: filename },
    };

    const response = await axios.post(GOPEED_CREATE_TASK, payload, {
      timeout: 15000,
    });

    if (response.data?.code === 0) {
      const taskId = response.data.data;
      return taskId;
    }

    throw new Error(response.data?.msg || "Gopeed create task failed");
  }

  async deleteVideoDownloads(userId: string, videoIds: string[]) {
    const result = await this.videoDownloadRepository.delete({
      id: In(videoIds),
      userId,
    });

    return { deleted: result.affected || 0 };
  }
}
