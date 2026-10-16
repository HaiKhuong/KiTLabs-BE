import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { UnrecoverableError } from "bullmq";
import { stat } from "fs/promises";
import { Repository } from "typeorm";

import { decryptSecret, encryptSecret } from "../../common/config/settings-crypto";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { FacebookAccount } from "./facebook-account.entity";
import { FacebookAffiliateLink } from "./facebook-affiliate-link.entity";
import { renderCommentTemplate, selectAffiliateLinks } from "./facebook-affiliate.selector";
import { FacebookCommentSettings } from "./facebook-comment-settings.entity";
import { FacebookPage } from "./facebook-page.entity";
import { FacebookPost } from "./facebook-post.entity";
import { FacebookProviderAdapter, FacebookProviderError } from "./facebook-provider.adapter";
import { FacebookTaskLog } from "./facebook-task-log.entity";
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

const CHUNK_BYTES = Number(process.env.FACEBOOK_UPLOAD_CHUNK_BYTES ?? 4 * 1024 * 1024);

@Injectable()
export class FacebookPublishRunner {
  private readonly logger = new Logger(FacebookPublishRunner.name);

  constructor(
    @InjectRepository(FacebookPost, "tool") private readonly posts: Repository<FacebookPost>,
    @InjectRepository(FacebookPage, "tool") private readonly pages: Repository<FacebookPage>,
    @InjectRepository(FacebookAccount, "tool") private readonly accounts: Repository<FacebookAccount>,
    @InjectRepository(FacebookAffiliateLink, "tool") private readonly links: Repository<FacebookAffiliateLink>,
    @InjectRepository(FacebookCommentSettings, "tool") private readonly settings: Repository<FacebookCommentSettings>,
    @InjectRepository(FacebookTaskLog, "tool") private readonly tasks: Repository<FacebookTaskLog>,
    private readonly provider: FacebookProviderAdapter,
    private readonly realtime: ToolsRealtimeGateway,
  ) {}

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
      if (!(post.facebookPostId && post.uploadPhase === FacebookUploadPhase.CONFIRMED)) {
        await this.publish(post, ready.page, ready.token);
      }
      await this.commentIfNeeded(post, ready.page, ready.token);
      post.status = FacebookPostStatus.PUBLISHED;
      post.publishedAt = post.publishedAt ?? new Date();
      post.errorCode = null;
      post.errorMessage = null;
      await this.posts.save(post);
      await this.writeLog({
        post,
        kind: FacebookTaskKind.PUBLISH,
        started,
        phaseBefore,
        outcome: FacebookTaskOutcome.SUCCESS,
        facebookObjectId: post.facebookPostId,
      });
      this.emit(post, "facebook.post.updated");
    } catch (error) {
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
        await this.markReview(
          post,
          providerError?.code ?? "UNCERTAIN_PUBLISH",
          "Không chắc bài đã lên Facebook chưa, nên không tự đăng lại.",
        );
        return;
      }
      await this.markFailed(post, providerError, started, phaseBefore);
      throw new UnrecoverableError("Facebook publish failed");
    }
  }

  async giveUp(postId: string, error: FacebookProviderError): Promise<void> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post || post.status !== FacebookPostStatus.PUBLISHING) return;
    await this.markFailed(post, error, new Date(), post.uploadPhase);
  }

  private async publish(post: FacebookPost, page: FacebookPage, token: string): Promise<void> {
    if (post.kind === FacebookContentKind.POST) {
      await this.publishOnce(post, () => this.provider.publishFeed(token, page.pageId, post.message ?? ""));
      return;
    }
    if (post.kind === FacebookContentKind.PHOTO) {
      await this.publishOnce(post, () =>
        this.provider.publishPhoto(token, page.pageId, post.localPath ?? "", post.message ?? post.title ?? ""),
      );
      return;
    }
    if (post.kind === FacebookContentKind.REEL) {
      await this.publishReel(post, page, token);
      return;
    }
    await this.publishVideo(post, page, token);
  }

  private async publishOnce(post: FacebookPost, send: () => Promise<{ id: string }>): Promise<void> {
    post.uploadPhase = FacebookUploadPhase.UNCERTAIN;
    post.status = FacebookPostStatus.PUBLISHING;
    await this.posts.save(post);
    try {
      const created = await send();
      post.facebookPostId = created.id;
      post.uploadPhase = FacebookUploadPhase.CONFIRMED;
      await this.posts.save(post);
    } catch (error) {
      if (error instanceof FacebookProviderError && error.retryable && !error.uncertain) {
        post.uploadPhase = FacebookUploadPhase.NONE;
        await this.posts.save(post);
      }
      throw error;
    }
  }

  private async publishVideo(post: FacebookPost, page: FacebookPage, token: string): Promise<void> {
    const filePath = post.localPath ?? "";
    const fileSize = Number(post.fileSize ?? (await stat(filePath)).size);
    post.status = FacebookPostStatus.PUBLISHING;
    if (!post.facebookPostId || !post.uploadSessionId) {
      const started = await this.provider.startVideo(token, page.pageId, fileSize);
      post.facebookPostId = started.videoId;
      post.uploadSessionId = started.uploadSessionId;
      post.uploadOffset = String(started.startOffset);
      post.uploadPhase = FacebookUploadPhase.STARTED;
      await this.posts.save(post);
      await this.transferUntilDone(post, page, token, filePath, fileSize, started.endOffset);
    } else {
      await this.transferUntilDone(post, page, token, filePath, fileSize, Number(post.uploadOffset) + CHUNK_BYTES);
    }
    post.uploadPhase = FacebookUploadPhase.UNCERTAIN;
    await this.posts.save(post);
    await this.provider.finishVideo(
      token,
      page.pageId,
      post.uploadSessionId,
      post.title ?? post.originalFileName ?? "Video",
      post.message ?? "",
    );
    post.uploadPhase = FacebookUploadPhase.CONFIRMED;
    await this.posts.save(post);
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
      const next = await this.provider.transferVideo({
        pageToken: token,
        pageId: page.pageId,
        uploadSessionId: post.uploadSessionId ?? "",
        filePath,
        startOffset: start,
        endOffset: end,
      });
      start = next.startOffset;
      post.uploadOffset = String(start);
      await this.posts.save(post);
      this.emit(post, "facebook.post.updated");
      if (start >= fileSize || next.startOffset === next.endOffset) break;
      end = Math.min(fileSize, next.endOffset || start + CHUNK_BYTES);
    }
  }

  private async publishReel(post: FacebookPost, page: FacebookPage, token: string): Promise<void> {
    const filePath = post.localPath ?? "";
    const fileSize = Number(post.fileSize ?? (await stat(filePath)).size);
    post.status = FacebookPostStatus.PUBLISHING;
    if (!post.facebookPostId || !post.uploadSessionId) {
      const started = await this.provider.startReel(token, page.pageId);
      post.facebookPostId = started.videoId;
      post.uploadSessionId = started.uploadUrl;
      post.uploadPhase = FacebookUploadPhase.STARTED;
      await this.posts.save(post);
    }
    if (post.uploadPhase === FacebookUploadPhase.STARTED) {
      await this.provider.uploadReel(post.uploadSessionId ?? "", token, filePath, fileSize);
    }
    post.uploadPhase = FacebookUploadPhase.UNCERTAIN;
    await this.posts.save(post);
    await this.provider.finishReel(token, page.pageId, post.facebookPostId ?? "", post.message ?? post.title ?? "");
    post.uploadPhase = FacebookUploadPhase.CONFIRMED;
    await this.posts.save(post);
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
    const page = await this.pages.findOne({ where: { id: post.pageId }, relations: { account: true } });
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
    this.realtime.notifyUser(post.userId, event, { postId: post.id, status: post.status });
  }
}
