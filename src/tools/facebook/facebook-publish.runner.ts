import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { UnrecoverableError } from "bullmq";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { basename } from "path";
import { Repository } from "typeorm";

import { AppConfigService } from "../../common/config/app-config.service";
import { decryptSecret, encryptSecret } from "../../common/config/settings-crypto";
import { PlatformFacebookService } from "../../platform/facebook/platform-facebook.service";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { TelegramService } from "../telegram/telegram.service";
import { FacebookAccount } from "./facebook-account.entity";
import { FacebookAffiliateLink } from "./facebook-affiliate-link.entity";
import { renderCommentTemplate, selectAffiliateLinks } from "./facebook-affiliate.selector";
import { FacebookCommentSettings } from "./facebook-comment-settings.entity";
import { FacebookPage } from "./facebook-page.entity";
import { FacebookPost } from "./facebook-post.entity";
import { FacebookProviderAdapter, FacebookProviderError } from "./facebook-provider.adapter";
import { FacebookTaskLog } from "./facebook-task-log.entity";
import { FacebookFilmIntegrationClient } from "./facebook-film-integration.client";
import {
  FacebookAccountStatus,
  FacebookCommentAttempt,
  FacebookContentKind,
  FacebookPageStatus,
  FacebookPostStatus,
  FacebookTaskKind,
  FacebookTaskOutcome,
  FacebookUploadPhase,
  FACEBOOK_REQUIRED_SCOPES,
} from "./facebook.types";

const CHUNK_BYTES = Number(process.env.FACEBOOK_UPLOAD_CHUNK_BYTES ?? 16 * 1024 * 1024);

class FacebookPublishCancelled extends Error {}

export function formatCaptionWithTitle(title?: string | null, message?: string | null): string {
  const cleanTitle = (title ?? "").trim();
  const cleanMessage = (message ?? "").trim();
  if (cleanTitle && cleanMessage) {
    if (cleanMessage === cleanTitle || cleanMessage.startsWith(`${cleanTitle}\n`)) {
      return cleanMessage;
    }
    return `${cleanTitle}\n\n${cleanMessage}`;
  }
  return cleanMessage || cleanTitle;
}

@Injectable()
export class FacebookPublishRunner {
  private readonly logger = new Logger(FacebookPublishRunner.name);
  private readonly cancelledPosts = new Set<string>();
  private readonly activeUploads = new Map<string, AbortController>();

  constructor(
    @InjectRepository(FacebookPost, "tool") private readonly posts: Repository<FacebookPost>,
    @InjectRepository(FacebookPage, "tool") private readonly pages: Repository<FacebookPage>,
    @InjectRepository(FacebookAccount, "tool") private readonly accounts: Repository<FacebookAccount>,
    @InjectRepository(FacebookAffiliateLink, "tool") private readonly links: Repository<FacebookAffiliateLink>,
    @InjectRepository(FacebookCommentSettings, "tool") private readonly settings: Repository<FacebookCommentSettings>,
    @InjectRepository(FacebookTaskLog, "tool") private readonly tasks: Repository<FacebookTaskLog>,
    private readonly provider: FacebookProviderAdapter,
    private readonly platformFb: PlatformFacebookService,
    private readonly realtime: ToolsRealtimeGateway,
    private readonly appConfig: AppConfigService,
    private readonly telegramService: TelegramService,
    private readonly filmIntegration: FacebookFilmIntegrationClient,
  ) { }

  requestCancel(postId: string): void {
    this.cancelledPosts.add(postId);
    this.activeUploads.get(postId)?.abort();
  }

  async run(postId: string): Promise<void> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post) return;
    if ([FacebookPostStatus.CANCELLED, FacebookPostStatus.PUBLISHED, FacebookPostStatus.BLOCKED].includes(post.status)) {
      return;
    }
    if (post.status === FacebookPostStatus.NEEDS_REVIEW) return;
    if (post.uploadPhase === FacebookUploadPhase.UNCERTAIN && !post.facebookPostId) {
      await this.markReview(post, "UNCERTAIN_PUBLISH", "Lần đăng trước không xác nhận được Post ID. Không tự đăng lại.");
      return;
    }

    const ready = await this.ensureAccess(post);
    if (!ready) return;

    const started = new Date();
    const phaseBefore = post.uploadPhase;
    try {
      await this.assertNotCancelled(post);
      post.status = FacebookPostStatus.PUBLISHING;
      await this.posts.save(post);
      this.emit(post, "facebook.post.updated");

      if (!(post.facebookPostId && post.uploadPhase === FacebookUploadPhase.CONFIRMED)) {
        await this.publish(post, ready.page, ready.token);
      }
      await this.assertNotCancelled(post);
      await this.commentIfNeeded(post, ready.page, ready.token);
      await this.assertNotCancelled(post);
      post.status = FacebookPostStatus.PUBLISHED;
      post.publishedAt = post.publishedAt ?? new Date();
      post.errorCode = null;
      post.errorMessage = null;
      await this.posts.save(post);
      await this.syncFilmIfNeeded(post, ready.page);
      await this.writeLog({
        post,
        kind: FacebookTaskKind.PUBLISH,
        started,
        phaseBefore,
        outcome: FacebookTaskOutcome.SUCCESS,
        facebookObjectId: post.facebookPostId,
      });
      this.emit(post, "facebook.post.updated");
      try {
        await this.notifyTelegram(post, ready.page);
      } catch {
        this.logger.warn(`Telegram notification could not be attempted for Facebook post=${post.id}.`);
      }
    } catch (error) {
      if (error instanceof FacebookPublishCancelled || this.cancelledPosts.has(post.id)) return;
      const providerError = error instanceof FacebookProviderError ? error : null;
      if (providerError?.permission) {
        await this.block(post, providerError.code, "Page hoặc token không còn quyền đăng.");
        return;
      }
      const canResume =
        post.uploadPhase === FacebookUploadPhase.NONE ||
        (post.uploadPhase === FacebookUploadPhase.STARTED && Boolean(post.facebookPostId));
      if (canResume && (providerError?.retryable || (providerError?.uncertain && post.uploadPhase === FacebookUploadPhase.STARTED))) {
        throw providerError?.retryable
          ? providerError
          : new FacebookProviderError(providerError?.code ?? "NETWORK", true, false, false, providerError?.httpStatus, providerError?.detail);
      }
      if (providerError?.uncertain || post.uploadPhase === FacebookUploadPhase.UNCERTAIN) {
        const detailMsg = providerError?.detail ? `[Facebook: ${providerError.detail}] ` : "";
        await this.markReview(
          post,
          providerError?.code ?? "UNCERTAIN_PUBLISH",
          `${detailMsg}Không chắc bài đã lên Facebook chưa, nên không tự đăng lại.`,
        );
        return;
      }
      await this.markFailed(post, providerError, started, phaseBefore);
      throw new UnrecoverableError("Facebook publish failed");
    } finally {
      this.activeUploads.delete(post.id);
      this.cancelledPosts.delete(post.id);
    }
  }

  private async syncFilmIfNeeded(post: FacebookPost, page: FacebookPage): Promise<void> {
    if (!post.filmSyncEnabled || (post.kind !== FacebookContentKind.VIDEO && post.kind !== FacebookContentKind.REEL)) return;
    try {
      const result = await this.filmIntegration.sync(post, page);
      post.filmSyncStatus = "synced";
      post.filmSyncError = null;
      post.filmEpisodeId = result.episodeId;
      post.filmSourceId = result.sourceId;
      post.filmSyncedAt = new Date();
    } catch (error) {
      post.filmSyncStatus = "failed";
      post.filmSyncError = error instanceof Error ? error.message : "Không thể đồng bộ Film DB";
      this.logger.warn(`Film sync failed post=${post.id}: ${post.filmSyncError}`);
    }
    await this.posts.save(post);
  }

  private async assertNotCancelled(post: FacebookPost): Promise<void> {
    if (this.cancelledPosts.has(post.id)) throw new FacebookPublishCancelled();
    const current = await this.posts.findOne({ where: { id: post.id }, select: { id: true, status: true } });
    if (current?.status === FacebookPostStatus.CANCELLED) throw new FacebookPublishCancelled();
  }

  private escapeTelegramMarkdown(str: string): string {
    return str.replace(/([_*`\[])/g, "\\$1");
  }

  private async getMediaDuration(filePath?: string | null): Promise<string> {
    if (!filePath || !existsSync(filePath)) return "Không xác định";
    try {
      const ffprobe = process.env.FFPROBE_BIN ?? "ffprobe";
      const result = spawnSync(
        ffprobe,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          filePath,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 5000 },
      );
      if (result.status === 0 && result.stdout) {
        const sec = parseFloat(result.stdout.trim());
        if (!isNaN(sec) && sec > 0) {
          return this.formatDurationSeconds(sec);
        }
      }
    } catch {
      // fallback to ffmpeg
    }

    try {
      const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
      const result = spawnSync(
        ffmpeg,
        ["-i", filePath],
        { encoding: "utf8", windowsHide: true, timeout: 5000 },
      );
      const out = (result.stderr || "") + (result.stdout || "");
      const match = out.match(/Duration:\s*(\d{2}:\d{2}:\d{2})/i);
      if (match) {
        return match[1];
      }
    } catch {
      // ignore
    }

    return "Không xác định";
  }

  private formatDurationSeconds(seconds: number): string {
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  private async notifyTelegram(post: FacebookPost, page: FacebookPage): Promise<void> {
    const rawToken = this.appConfig.getSecret("TELEGRAM_BOT_TOKEN").trim();
    const rawChatId = this.appConfig.get("TELEGRAM_CHAT_ID").trim();
    // Hệ thống chỉ hỗ trợ 1 BOT TOKEN và 1 CHAT ID duy nhất
    const token = rawToken.split(/[,;\s]+/)[0]?.trim();
    const chatId = rawChatId.split(/[,;\s]+/)[0]?.trim();
    if (!token || !chatId) return;

    const videoTitle = post.title?.trim() || post.originalFileName || "Không có tiêu đề";
    const type = post.kind || "video";
    const originalFileName = post.originalFileName || (post.localPath ? basename(post.localPath) : "N/A");

    let duration = "Không áp dụng";
    if (post.kind === FacebookContentKind.VIDEO || post.kind === FacebookContentKind.REEL) {
      duration = await this.getMediaDuration(post.localPath);
    }

    const facebookPostUrl = post.facebookPostId
      ? `https://www.facebook.com/${post.facebookPostId}`
      : `https://www.facebook.com/${page.pageId}`;

    const publishDate = post.publishedAt ? new Date(post.publishedAt) : new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const publishTime = `${pad(publishDate.getHours())}:${pad(publishDate.getMinutes())}:${pad(publishDate.getSeconds())} ${pad(publishDate.getDate())}/${pad(publishDate.getMonth() + 1)}/${publishDate.getFullYear()}`;

    const pageName = page?.name ? this.escapeTelegramMarkdown(page.name) : "N/A";

    const messageText = [
      "✅ *ĐĂNG VIDEO FACEBOOK THÀNH CÔNG!*",
      "",
      `🌐 *Fanpage:* ${pageName}`,
      `🎬 *Tiêu đề:* ${this.escapeTelegramMarkdown(videoTitle)}`,
      `*Thời lượng:* ${duration}`,
      `*Loại bài viết:* ${type}`,
      `*File:* ${this.escapeTelegramMarkdown(originalFileName)}`,
      "",
      `🔗 [Xem video trên Facebook](${facebookPostUrl})`,
      "",
      "🤖 *System Info:*",
      "• Trạng thái: Published",
      `• Thời gian: ${publishTime}`,
    ].join("\n");

    try {
      await this.telegramService.sendMessage(chatId, messageText, {
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Telegram notification failed for Facebook post=${post.id}: ${msg}`);
    }
  }

  async giveUp(postId: string, error: FacebookProviderError): Promise<void> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post || post.status !== FacebookPostStatus.PUBLISHING) return;
    await this.markFailed(post, error, new Date(), post.uploadPhase);
  }

  private async publish(post: FacebookPost, page: FacebookPage, token: string): Promise<void> {
    await this.assertSourceMediaIntact(post);
    const fullDescription = formatCaptionWithTitle(post.title, post.message);
    if (post.kind === FacebookContentKind.POST) {
      await this.publishOnce(post, () => this.provider.publishFeed(token, page.pageId, fullDescription));
      return;
    }
    if (post.kind === FacebookContentKind.PHOTO) {
      await this.publishOnce(post, () =>
        this.provider.publishPhoto(token, page.pageId, post.localPath ?? "", fullDescription),
      );
      return;
    }
    if (post.kind === FacebookContentKind.REEL) {
      await this.publishReel(post, page, token);
      return;
    }
    await this.publishVideo(post, page, token);
  }

  /**
   * Media được dùng trực tiếp từ file gốc người dùng chọn (không copy), nên trước khi upload
   * phải chắc chắn file vẫn còn và không bị sửa đổi (đổi dung lượng sẽ làm hỏng resumable offset).
   */
  private async assertSourceMediaIntact(post: FacebookPost): Promise<void> {
    if (post.kind === FacebookContentKind.POST || !post.localPath) return;
    let currentSize: number;
    try {
      const info = await stat(post.localPath);
      if (!info.isFile()) throw new Error("not a file");
      currentSize = info.size;
    } catch {
      throw new FacebookProviderError(
        "MEDIA_MISSING",
        false,
        false,
        false,
        undefined,
        "Không tìm thấy tệp gốc (đã bị xóa, đổi tên hoặc di chuyển).",
      );
    }
    if (post.fileSize && Number(post.fileSize) !== currentSize) {
      throw new FacebookProviderError(
        "MEDIA_CHANGED",
        false,
        false,
        false,
        undefined,
        "Tệp gốc đã bị thay đổi sau khi tạo bài. Hãy chọn lại tệp.",
      );
    }
  }

  private async publishOnce(post: FacebookPost, send: () => Promise<{ id: string }>): Promise<void> {
    await this.assertNotCancelled(post);
    post.uploadPhase = FacebookUploadPhase.STARTED;
    post.status = FacebookPostStatus.PUBLISHING;
    await this.posts.save(post);
    this.emit(post, "facebook.post.updated");

    post.uploadPhase = FacebookUploadPhase.UNCERTAIN;
    await this.posts.save(post);
    this.emit(post, "facebook.post.updated");
    try {
      const created = await send();
      await this.assertNotCancelled(post);
      post.facebookPostId = created.id;
      post.uploadPhase = FacebookUploadPhase.CONFIRMED;
      if (post.fileSize) post.uploadOffset = post.fileSize;
      await this.posts.save(post);
      this.emit(post, "facebook.post.updated");
    } catch (error) {
      if (error instanceof FacebookProviderError && error.retryable && !error.uncertain) {
        post.uploadPhase = FacebookUploadPhase.NONE;
        await this.posts.save(post);
        this.emit(post, "facebook.post.updated");
      }
      throw error;
    }
  }

  private async publishVideo(post: FacebookPost, page: FacebookPage, token: string): Promise<void> {
    await this.assertNotCancelled(post);
    const filePath = post.localPath ?? "";
    const fileSize = Number(post.fileSize ?? (await stat(filePath)).size);
    post.status = FacebookPostStatus.PUBLISHING;
    if (!post.facebookPostId || !post.uploadSessionId) {
      const started = await this.provider.startVideo(token, page.pageId, fileSize);
      await this.assertNotCancelled(post);
      post.facebookPostId = started.videoId;
      post.uploadSessionId = started.uploadSessionId;
      post.uploadOffset = String(started.startOffset);
      post.uploadPhase = FacebookUploadPhase.STARTED;
      await this.posts.save(post);
      this.emit(post, "facebook.post.updated");
      await this.transferUntilDone(post, page, token, filePath, fileSize, started.endOffset);
    } else {
      await this.transferUntilDone(post, page, token, filePath, fileSize, Number(post.uploadOffset) + CHUNK_BYTES);
    }
    await this.assertNotCancelled(post);
    post.uploadOffset = String(fileSize);
    post.uploadPhase = FacebookUploadPhase.UNCERTAIN;
    await this.posts.save(post);
    this.emit(post, "facebook.post.updated");

    const fullDescription = formatCaptionWithTitle(post.title, post.message);
    await this.provider.finishVideo(
      token,
      page.pageId,
      post.uploadSessionId,
      post.title ?? post.originalFileName ?? "Video",
      fullDescription,
      post.thumbnailPath,
    );
    await this.assertNotCancelled(post);
    post.uploadPhase = FacebookUploadPhase.CONFIRMED;
    await this.posts.save(post);
    this.emit(post, "facebook.post.updated");
  }

  private async transferUntilDone(
    post: FacebookPost,
    page: FacebookPage,
    token: string,
    filePath: string,
    fileSize: number,
    firstEnd: number,
  ): Promise<void> {
    let start = Number(post.uploadOffset);
    let end = Math.min(fileSize, Math.max(firstEnd, start + Math.min(CHUNK_BYTES, fileSize - start)));
    while (start < fileSize) {
      await this.assertNotCancelled(post);
      const next = await this.provider.transferVideo({
        pageToken: token,
        pageId: page.pageId,
        uploadSessionId: post.uploadSessionId ?? "",
        filePath,
        startOffset: start,
        endOffset: end,
      });
      await this.assertNotCancelled(post);
      start = next.startOffset;
      post.uploadOffset = String(start);
      await this.posts.save(post);
      this.emit(post, "facebook.post.updated");
      if (start >= fileSize || next.startOffset === next.endOffset) break;
      end = Math.min(fileSize, next.endOffset || start + CHUNK_BYTES);
    }
  }

  private async publishReel(post: FacebookPost, page: FacebookPage, token: string): Promise<void> {
    await this.assertNotCancelled(post);
    const filePath = post.localPath ?? "";
    const fileSize = Number(post.fileSize ?? (await stat(filePath)).size);
    post.status = FacebookPostStatus.PUBLISHING;
    if (!post.facebookPostId || !post.uploadSessionId) {
      const started = await this.provider.startReel(token, page.pageId);
      await this.assertNotCancelled(post);
      post.facebookPostId = started.videoId;
      post.uploadSessionId = started.uploadUrl;
      post.uploadOffset = "0";
      post.uploadPhase = FacebookUploadPhase.STARTED;
      await this.posts.save(post);
      this.emit(post, "facebook.post.updated");
    }
    if (post.uploadPhase === FacebookUploadPhase.STARTED) {
      const controller = new AbortController();
      this.activeUploads.set(post.id, controller);
      await this.provider.uploadReel(post.uploadSessionId ?? "", token, filePath, fileSize, (uploadedBytes) => {
        post.uploadOffset = String(uploadedBytes);
        void this.posts
          .update(post.id, { uploadOffset: String(uploadedBytes) })
          .then(() => this.emit(post, "facebook.post.updated"))
          .catch(() => undefined);
      }, controller.signal);
      this.activeUploads.delete(post.id);
      await this.assertNotCancelled(post);
    }
    post.uploadOffset = String(fileSize);
    post.uploadPhase = FacebookUploadPhase.UNCERTAIN;
    await this.posts.save(post);
    this.emit(post, "facebook.post.updated");

    const fullDescription = formatCaptionWithTitle(post.title, post.message);
    await this.provider.finishReel(
      token,
      page.pageId,
      post.facebookPostId ?? "",
      fullDescription,
      post.title,
    );
    await this.assertNotCancelled(post);

    if (post.thumbnailPath && post.facebookPostId) {
      try {
        await this.provider.uploadVideoThumbnail(token, post.facebookPostId, post.thumbnailPath);
      } catch (thumbErr) {
        this.logger.warn(
          `Reel custom thumbnail skipped for post=${post.id}: ${thumbErr instanceof Error ? thumbErr.message : String(thumbErr)}`,
        );
      }
    }

    post.uploadPhase = FacebookUploadPhase.CONFIRMED;
    await this.posts.save(post);
    this.emit(post, "facebook.post.updated");
  }

  private async commentIfNeeded(post: FacebookPost, page: FacebookPage, token: string): Promise<void> {
    if (!post.affiliateEnabled || !post.facebookPostId) return;
    const settings = await this.settings.findOne({ where: { userId: post.userId } });
    if (!settings) return;
    const videoLike = post.kind === FacebookContentKind.VIDEO || post.kind === FacebookContentKind.REEL;
    const enabled = videoLike ? settings.autoCommentVideo : settings.autoCommentPost;
    if (!enabled || !page.canComment) return;
    if (post.commentResults.length === 0) {
      const links = await this.links.find({ where: { userId: post.userId }, order: { createdAt: "ASC" } });
      const selected = selectAffiliateLinks({
        links,
        pageGraphId: page.pageId,
        content: `${post.title ?? ""}\n${post.message ?? ""}`,
        count: settings.commentCount,
        rule: settings.selectionRule,
        cursor: settings.sequentialCursor,
        now: new Date(),
      });
      const templates = settings.templates.filter((item) => item.enabled && item.body.trim());
      const fallback = "{name}\n{link}";
      post.commentResults = selected.picked.map((link, index) => ({
        linkId: link.id,
        message: renderCommentTemplate(templates[index % Math.max(templates.length, 1)]?.body || fallback, link).slice(0, 8000),
        commentId: null,
        status: "pending",
        errorCode: null,
      }));
      settings.sequentialCursor = selected.nextCursor;
      await this.settings.save(settings);
      await this.posts.save(post);
    }
    for (const attempt of post.commentResults) {
      if (attempt.status !== "pending") continue;
      await this.assertNotCancelled(post);
      await this.sendComment(post, token, attempt);
    }
  }

  private async sendComment(post: FacebookPost, token: string, attempt: FacebookCommentAttempt): Promise<void> {
    const started = new Date();
    try {
      const created = await this.provider.comment(token, post.facebookPostId ?? "", attempt.message);
      attempt.commentId = created.id;
      attempt.status = "done";
      attempt.errorCode = null;
      await this.posts.save(post);
      await this.writeLog({
        post,
        kind: FacebookTaskKind.COMMENT,
        started,
        phaseBefore: post.uploadPhase,
        outcome: FacebookTaskOutcome.SUCCESS,
        facebookObjectId: created.id,
      });
    } catch (error) {
      const providerError = error instanceof FacebookProviderError ? error : null;
      if (providerError?.uncertain) {
        attempt.status = "uncertain";
        attempt.errorCode = providerError.code;
        await this.posts.save(post);
        await this.writeLog({
          post,
          kind: FacebookTaskKind.COMMENT,
          started,
          phaseBefore: post.uploadPhase,
          outcome: FacebookTaskOutcome.NEEDS_REVIEW,
          error: providerError,
        });
        return;
      }
      if (providerError?.retryable) throw providerError;
      attempt.status = "failed";
      attempt.errorCode = providerError?.code ?? "COMMENT_FAILED";
      await this.posts.save(post);
      await this.writeLog({
        post,
        kind: FacebookTaskKind.COMMENT,
        started,
        phaseBefore: post.uploadPhase,
        outcome: FacebookTaskOutcome.FAILED,
        error: providerError,
      });
    }
  }

  private async ensureAccess(post: FacebookPost): Promise<{ page: FacebookPage; token: string } | null> {
    const started = new Date();
    if (!post.pageId) {
      await this.block(post, "PAGE_MISSING", "Bài không còn gắn với Page.");
      return null;
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(post.pageId);
    let page = await this.pages.findOne({
      where: isUuid ? [{ id: post.pageId }, { pageId: post.pageId }] : { pageId: post.pageId },
      relations: { account: true },
    });

    // 1. Try PlatformFacebookService (new Platform OAuth integration)
    try {
      const valid = await this.platformFb.getValidPageAccessToken(post.userId, page?.pageId || post.pageId);
      if (page) {
        page.name = valid.page.name;
        page.canPublish = valid.page.canPublish;
        page.canComment = valid.page.canComment;
        page.status = FacebookPageStatus.ACTIVE;
        page.lastCheckedAt = new Date();
        await this.pages.save(page);
      } else {
        page = this.pages.create({
          id: valid.page.id,
          pageId: valid.page.pageId,
          name: valid.page.name,
          canPublish: valid.page.canPublish,
          canComment: valid.page.canComment,
          status: FacebookPageStatus.ACTIVE,
          lastCheckedAt: new Date(),
        });
        await this.pages.save(page);
      }

      if (!post.localPath && post.kind !== FacebookContentKind.POST) {
        await this.markFailed(post, new FacebookProviderError("MEDIA_MISSING", false, false, false), started, post.uploadPhase);
        return null;
      }
      return { page, token: valid.token };
    } catch (platformErr) {
      this.logger.warn(
        `Platform token verification failed for post=${post.id}: ${platformErr instanceof Error ? platformErr.message : String(platformErr)}`,
      );

      // 2. Fallback to legacy account if present
      if (page?.account && page.account.accessTokenEncrypted) {
        return this.ensureAccessLegacy(post, page, started);
      }

      const message =
        platformErr instanceof Error
          ? platformErr.message
          : "Page hoặc tài khoản Facebook mất quyền đăng. Hãy kết nối lại.";
      await this.block(post, "PAGE_ACCESS_LOST", message);
      return null;
    }
  }

  private async ensureAccessLegacy(
    post: FacebookPost,
    page: FacebookPage,
    started: Date,
  ): Promise<{ page: FacebookPage; token: string } | null> {
    if (!page?.account || page.status !== FacebookPageStatus.ACTIVE || !page.canPublish || !page.pageAccessTokenEncrypted) {
      await this.block(post, "PAGE_ACCESS_LOST", "Page mất quyền đăng. Hãy kết nối lại.");
      return null;
    }
    const account = page.account;
    if (account.status !== FacebookAccountStatus.CONNECTED || !account.accessTokenEncrypted) {
      await this.block(post, "ACCOUNT_NOT_CONNECTED", "Tài khoản Facebook chưa sẵn sàng. Hãy kết nối lại.");
      return null;
    }
    try {
      const userToken = decryptSecret(account.accessTokenEncrypted);
      const debug = await this.provider.debugToken(userToken);
      const missing = FACEBOOK_REQUIRED_SCOPES.filter((scope) => !debug.scopes.includes(scope));
      if (!debug.isValid || (debug.expiresAt && debug.expiresAt.getTime() <= Date.now()) || missing.length > 0) {
        account.status = !debug.isValid ? FacebookAccountStatus.REVOKED : missing.length ? FacebookAccountStatus.MISSING_PERMISSION : FacebookAccountStatus.EXPIRED;
        account.lastCheckedAt = new Date();
        account.lastCheckMessage = missing.length ? `Thiếu quyền: ${missing.join(", ")}` : "Token không còn hiệu lực";
        await this.accounts.save(account);
        await this.block(post, account.status, account.lastCheckMessage);
        return null;
      }
      const grants = await this.provider.listPages(userToken);
      const grant = grants.find((item) => item.id === page.pageId);
      if (!grant) {
        page.status = FacebookPageStatus.LOST_ACCESS;
        page.canPublish = false;
        await this.pages.save(page);
        await this.block(post, "PAGE_ACCESS_LOST", "Page không còn trong tài khoản Facebook.");
        return null;
      }
      const tasks = grant.tasks ?? [];
      page.canPublish = tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE");
      page.canComment = page.canPublish || tasks.includes("MODERATE");
      page.tasks = tasks;
      page.pageAccessTokenEncrypted = encryptSecret(grant.accessToken);
      page.lastCheckedAt = new Date();
      if (!page.canPublish) {
        page.status = FacebookPageStatus.LOST_ACCESS;
        await this.pages.save(page);
        await this.block(post, "PAGE_PUBLISH_DENIED", "Page không còn quyền đăng bài.");
        return null;
      }
      page.status = FacebookPageStatus.ACTIVE;
      await this.pages.save(page);
      account.lastCheckedAt = new Date();
      account.lastCheckMessage = null;
      await this.accounts.save(account);
      if (!post.localPath && post.kind !== FacebookContentKind.POST) {
        await this.markFailed(post, new FacebookProviderError("MEDIA_MISSING", false, false, false), started, post.uploadPhase);
        return null;
      }
      return { page, token: grant.accessToken };
    } catch (error) {
      if (error instanceof FacebookProviderError && error.permission) {
        account.status = FacebookAccountStatus.REVOKED;
        account.lastCheckMessage = "Token bị từ chối";
        account.lastCheckedAt = new Date();
        await this.accounts.save(account);
        await this.block(post, error.code, "Tài khoản Facebook hết quyền. Hãy kết nối lại.");
        return null;
      }
      if (error instanceof FacebookProviderError && (error.retryable || error.uncertain)) {
        await this.writeLog({
          post,
          kind: FacebookTaskKind.PERMISSION_CHECK,
          started,
          phaseBefore: post.uploadPhase,
          outcome: FacebookTaskOutcome.FAILED,
          error,
        });
        throw error.retryable ? error : new FacebookProviderError(error.code, true, false, false, error.httpStatus, error.detail);
      }
      throw error;
    }
  }

  private async block(post: FacebookPost, code: string, message: string): Promise<void> {
    post.status = FacebookPostStatus.BLOCKED;
    post.errorCode = code;
    post.errorMessage = message;
    await this.posts.save(post);
    await this.writeLog({
      post,
      kind: FacebookTaskKind.PERMISSION_CHECK,
      started: new Date(),
      phaseBefore: post.uploadPhase,
      outcome: FacebookTaskOutcome.FAILED,
      error: new FacebookProviderError(code, false, false, true, undefined, message),
    });
    this.emit(post, "facebook.account.updated");
    this.emit(post, "facebook.post.updated");
  }

  private async markReview(post: FacebookPost, code: string, message: string): Promise<void> {
    post.status = FacebookPostStatus.NEEDS_REVIEW;
    post.errorCode = code;
    post.errorMessage = message;
    await this.posts.save(post);
    await this.writeLog({
      post,
      kind: FacebookTaskKind.PUBLISH,
      started: new Date(),
      phaseBefore: post.uploadPhase,
      outcome: FacebookTaskOutcome.NEEDS_REVIEW,
      error: new FacebookProviderError(code, false, true, false, undefined, message),
    });
    this.emit(post, "facebook.post.updated");
  }

  private async markFailed(
    post: FacebookPost,
    error: FacebookProviderError | null,
    started: Date,
    phaseBefore: string,
  ): Promise<void> {
    post.status = FacebookPostStatus.FAILED;
    post.errorCode = error?.code ?? "PUBLISH_FAILED";
    post.errorMessage = "Facebook từ chối hoặc không hoàn tất bài đăng.";
    post.errorMessage =
      error?.code === "MEDIA_MISSING" || error?.code === "MEDIA_CHANGED"
        ? (error.detail ?? "Tệp gốc không còn hợp lệ.")
        : "Facebook từ chối hoặc không hoàn tất bài đăng.";
    await this.posts.save(post);
    await this.writeLog({
      post,
      kind: FacebookTaskKind.PUBLISH,
      started,
      phaseBefore,
      outcome: FacebookTaskOutcome.FAILED,
      error,
    });
    this.logger.warn(`Facebook publish failed post=${post.id} code=${post.errorCode}`);
    this.emit(post, "facebook.post.updated");
  }

  private async writeLog(input: {
    post: FacebookPost;
    kind: FacebookTaskKind;
    started: Date;
    phaseBefore: string;
    outcome: FacebookTaskOutcome;
    facebookObjectId?: string | null;
    error?: FacebookProviderError | null;
  }): Promise<void> {
    const attempt = (await this.tasks.count({ where: { postId: input.post.id, kind: input.kind } })) + 1;
    await this.tasks.save(
      this.tasks.create({
        userId: input.post.userId,
        postId: input.post.id,
        pageId: input.post.pageId,
        kind: input.kind,
        attempt,
        startedAt: input.started,
        finishedAt: new Date(),
        facebookObjectId: input.facebookObjectId ?? input.post.facebookPostId,
        phaseBefore: input.phaseBefore,
        errorCode: input.error?.code ?? null,
        errorMessage: input.error?.detail?.slice(0, 500) ?? null,
        httpStatus: input.error?.httpStatus ?? null,
        retryable: input.error?.retryable === true && input.error.uncertain !== true,
        outcome: input.outcome,
      }),
    );
    this.realtime.notifyUser(input.post.userId, "facebook.task.updated", { postId: input.post.id });
  }

  private emit(post: FacebookPost, event: string): void {
    this.realtime.notifyUser(post.userId, event, {
      postId: post.id,
      status: post.status,
      uploadPhase: post.uploadPhase,
      uploadOffset: post.uploadOffset ? Number(post.uploadOffset) : 0,
      fileSize: post.fileSize ? Number(post.fileSize) : null,
      filmSyncStatus: post.filmSyncStatus,
      filmEpisodeId: post.filmEpisodeId,
      filmSourceId: post.filmSourceId,
    });
  }
}
