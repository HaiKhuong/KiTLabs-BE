import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Job, UnrecoverableError } from "bullmq";
import { Repository } from "typeorm";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { TikTokProviderAdapter, TikTokProviderError } from "./tiktok-provider.adapter";
import { TIKTOK_PUBLISH_QUEUE, TikTokService } from "./tiktok.service";
import { TikTokVideoStatus } from "./tiktok.types";
import { TikTokVideo } from "./tiktok-video.entity";

type PublishJob = {
  videoId: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
};

@Processor(TIKTOK_PUBLISH_QUEUE, {
  concurrency: 1,
  lockDuration: 180_000,
  stalledInterval: 60_000,
  maxStalledCount: 2,
})
export class TikTokProcessor extends WorkerHost {
  private readonly logger = new Logger(TikTokProcessor.name);

  constructor(
    @InjectRepository(TikTokVideo, "tool") private readonly videos: Repository<TikTokVideo>,
    private readonly service: TikTokService,
    private readonly provider: TikTokProviderAdapter,
    private readonly realtime: ToolsRealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<PublishJob>): Promise<void> {
    const video = await this.videos.findOne({ where: { id: job.data.videoId } });
    if (!video || !video.accountId) throw new UnrecoverableError("TikTok publish record not found");
    const account = await this.service.ownedAccount(video.userId, video.accountId);
    try {
      const accessToken = await this.service.validAccessToken(account);
      if (video.publishId && video.status === TikTokVideoStatus.PROCESSING) {
        await this.pollStatus(video, accessToken);
        return;
      }

      video.status = TikTokVideoStatus.UPLOADING;
      video.errorCode = null;
      video.errorMessage = null;
      await this.videos.save(video);
      this.emit(video, "tiktok.video.updated");

      const initialized = await this.provider.initializeDirectPost(accessToken, {
        caption: video.caption ?? "",
        privacyLevel: "SELF_ONLY",
        disableComment: job.data.disableComment,
        disableDuet: job.data.disableDuet,
        disableStitch: job.data.disableStitch,
        disclosure: this.service.disclosureFor(video),
        isAigc: video.isAigc,
        metadata: video.metadata,
      });
      if (!initialized.publishId || !initialized.uploadUrl) {
        throw new TikTokProviderError("INVALID_INIT_RESPONSE", false);
      }
      video.publishId = initialized.publishId;
      await this.videos.save(video);

      const total = Number(video.fileSize);
      const mimeType =
        video.metadata.format === "mov"
          ? "video/quicktime"
          : video.metadata.format === "webm"
            ? "video/webm"
            : "video/mp4";
      for (let index = 0; index < initialized.totalChunkCount; index += 1) {
        const start = index * initialized.chunkSize;
        const end =
          index === initialized.totalChunkCount - 1
            ? total - 1
            : start + initialized.chunkSize - 1;
        await this.provider.uploadChunk(
          initialized.uploadUrl,
          video.localPath,
          mimeType,
          start,
          end,
          total,
        );
        video.uploadedBytes = String(end + 1);
        await this.videos.save(video);
        this.emit(video, "tiktok.video.progress");
      }
      video.status = TikTokVideoStatus.PROCESSING;
      await this.videos.save(video);
      this.emit(video, "tiktok.video.updated");
      await this.pollStatus(video, accessToken);
    } catch (error) {
      const providerError = error instanceof TikTokProviderError ? error : null;
      const attempts = Number(job.opts.attempts ?? 1);
      const willRetry = providerError?.retryable === true && job.attemptsMade + 1 < attempts;
      this.logger.warn(
        `TikTok publish failed video=${video.id} code=${providerError?.code ?? "INTERNAL"} logId=${providerError?.logId ?? "none"} retry=${willRetry}`,
      );
      if (!willRetry) {
        video.status = TikTokVideoStatus.FAILED;
        video.errorCode = providerError?.code ?? "PUBLISH_FAILED";
        video.errorMessage = this.publicFailureMessage(providerError?.code);
        await this.videos.save(video);
        this.emit(video, "tiktok.video.failed");
        throw new UnrecoverableError("TikTok publish failed");
      }
      throw error;
    }
  }

  private async pollStatus(video: TikTokVideo, accessToken: string): Promise<void> {
    const deadline = Date.now() + Number(process.env.TIKTOK_STATUS_TIMEOUT_MS ?? 1_800_000);
    let delay = Math.max(2_100, Number(process.env.TIKTOK_STATUS_POLL_INITIAL_MS ?? 5_000));
    while (Date.now() < deadline) {
      const status = await this.provider.fetchPublishStatus(accessToken, video.publishId!);
      const providerStatus = String(status.status ?? "");
      if (status.uploaded_bytes != null) video.uploadedBytes = String(status.uploaded_bytes);
      if (providerStatus === "PUBLISH_COMPLETE") {
        video.status = TikTokVideoStatus.PUBLISHED;
        const publicPostIds =
          status.publicaly_available_post_id ?? status.publicly_available_post_id;
        video.providerPostId = Array.isArray(publicPostIds)
          ? publicPostIds[0]
            ? String(publicPostIds[0])
            : null
          : publicPostIds
            ? String(publicPostIds)
            : null;
        video.publishedAt = new Date();
        video.errorCode = null;
        video.errorMessage = null;
        await this.videos.save(video);
        this.emit(video, "tiktok.video.updated");
        return;
      }
      if (providerStatus === "FAILED") {
        const code = String(status.fail_reason ?? "PROVIDER_PROCESSING_FAILED");
        throw new TikTokProviderError(code, false);
      }
      await this.videos.save(video);
      this.emit(video, "tiktok.video.progress");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay + Math.floor(Math.random() * 500)));
      delay = Math.min(30_000, Math.round(delay * 1.6));
    }
    throw new TikTokProviderError("STATUS_TIMEOUT", true);
  }

  private emit(video: TikTokVideo, event: string): void {
    this.realtime.notifyUser(video.userId, event, {
      videoId: video.id,
      status: video.status,
      uploadedBytes: Number(video.uploadedBytes),
      fileSize: Number(video.fileSize),
      errorCode: video.errorCode,
      errorMessage: video.errorMessage,
      updatedAt: video.updatedAt,
    });
  }

  private publicFailureMessage(code?: string): string {
    if (code === "RATE_LIMITED" || code === "rate_limit_exceeded")
      return "TikTok đang giới hạn tần suất. Vui lòng thử lại sau.";
    if (code === "access_token_invalid") return "Kết nối TikTok đã hết hạn. Vui lòng kết nối lại.";
    if (["content_violations", "spam_risk", "spam_risk_text"].includes(code ?? ""))
      return "TikTok từ chối nội dung theo chính sách nền tảng.";
    if (code === "file_format_check_failed") return "TikTok không hỗ trợ định dạng của video này.";
    if (code === "duration_check_failed") return "Thời lượng video không phù hợp với tài khoản TikTok.";
    if (code === "frame_rate_check_failed") return "Tốc độ khung hình của video không được TikTok hỗ trợ.";
    if (code === "picture_size_check_failed") return "Kích thước khung hình không được TikTok hỗ trợ.";
    return "Không thể đăng video lên TikTok. Vui lòng kiểm tra tài khoản và thử lại.";
  }
}
