import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { copyFile } from "fs/promises";
import { extname, join, resolve } from "path";
import { In, LessThanOrEqual, Repository } from "typeorm";

import { PlatformFacebookService } from "../../platform/facebook/platform-facebook.service";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { FacebookAffiliateLink } from "./facebook-affiliate-link.entity";
import { FacebookCommentSettings } from "./facebook-comment-settings.entity";
import { assertHttpsUrl, validateFacebookMedia } from "./facebook-media.validation";
import { FacebookPage } from "./facebook-page.entity";
import { FacebookPost } from "./facebook-post.entity";
import { FacebookTaskLog } from "./facebook-task-log.entity";
import {
  CreateFacebookPostDto,
  FACEBOOK_PUBLISH_QUEUE,
  FacebookAffiliateStatus,
  FacebookContentKind,
  FacebookPostQueryDto,
  FacebookPostStatus,
  FacebookSelectionRule,
  FacebookTaskQueryDto,
  FacebookUploadPhase,
  SaveCommentSettingsDto,
  UpdateFacebookPostDto,
  UpsertAffiliateLinkDto,
} from "./facebook.types";

@Injectable()
export class FacebookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FacebookService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(FacebookPage, "tool") private readonly pages: Repository<FacebookPage>,
    @InjectRepository(FacebookPost, "tool") private readonly posts: Repository<FacebookPost>,
    @InjectRepository(FacebookAffiliateLink, "tool") private readonly links: Repository<FacebookAffiliateLink>,
    @InjectRepository(FacebookCommentSettings, "tool") private readonly commentSettings: Repository<FacebookCommentSettings>,
    @InjectRepository(FacebookTaskLog, "tool") private readonly tasks: Repository<FacebookTaskLog>,
    @InjectQueue(FACEBOOK_PUBLISH_QUEUE) private readonly queue: Queue,
    private readonly platformFb: PlatformFacebookService,
    private readonly realtime: ToolsRealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) =>
        this.logger.warn(`Facebook sweep failed: ${error instanceof Error ? error.message : "unknown"}`),
      );
    }, 120_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async listPosts(userId: string, query: FacebookPostQueryDto) {
    const page = Math.max(1, query.page);
    const limit = Math.min(50, Math.max(1, query.limit));
    const where = {
      userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.pageId ? { pageId: query.pageId } : {}),
    };
    const [rows, total] = await this.posts.findAndCount({
      where,
      relations: { page: true },
      order: { createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items: rows.map((row) => this.mapPost(row)), total, page, limit, hasMore: page * limit < total };
  }

  async createPost(userId: string, dto: CreateFacebookPostDto) {
    const page = await this.ownedPage(userId, dto.pageId);
    const media = await this.maybeStoreMedia(userId, dto.kind, dto.sourcePath);
    this.assertPublishable(dto.publish, dto.kind, dto.message, media?.localPath);
    const post = this.posts.create({
      userId,
      pageId: page.id,
      kind: dto.kind,
      title: dto.title?.trim() || media?.originalFileName || null,
      message: dto.message?.trim() || null,
      localPath: media?.localPath ?? null,
      originalFileName: media?.originalFileName ?? null,
      fileSize: media?.fileSize ?? null,
      affiliateEnabled: dto.affiliateEnabled,
      status: FacebookPostStatus.DRAFT,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      uploadPhase: FacebookUploadPhase.NONE,
      uploadOffset: "0",
      commentResults: [],
      sourcePostId: null,
      facebookPostId: null,
      uploadSessionId: null,
      queueJobId: null,
      errorCode: null,
      errorMessage: null,
      publishedAt: null,
    });
    await this.posts.save(post);
    if (dto.publish) await this.queuePost(post);
    post.page = page;
    return this.mapPost(post);
  }

  async updatePost(userId: string, id: string, dto: UpdateFacebookPostDto) {
    const post = await this.ownedPost(userId, id);
    if (![FacebookPostStatus.DRAFT, FacebookPostStatus.SCHEDULED].includes(post.status)) {
      throw new ConflictException("Chỉ sửa được bài nháp hoặc bài đang chờ đăng");
    }
    if (dto.pageId) post.pageId = (await this.ownedPage(userId, dto.pageId)).id;
    if (dto.kind) post.kind = dto.kind;
    if (dto.title !== undefined) post.title = dto.title.trim() || null;
    if (dto.message !== undefined) post.message = dto.message.trim() || null;
    if (dto.affiliateEnabled !== undefined) post.affiliateEnabled = dto.affiliateEnabled;
    if (dto.scheduledAt !== undefined) post.scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    if (dto.sourcePath) {
      const media = await this.maybeStoreMedia(userId, post.kind, dto.sourcePath);
      if (media) Object.assign(post, media);
    }
    const publish = dto.publish === true;
    this.assertPublishable(publish, post.kind, post.message, post.localPath);
    await this.posts.save(post);
    if (publish) await this.queuePost(post);
    else if (post.status === FacebookPostStatus.SCHEDULED && dto.publish === false) {
      await this.removeJob(post.id);
      post.status = FacebookPostStatus.DRAFT;
      post.queueJobId = null;
      await this.posts.save(post);
    }
    return this.mapPost(await this.ownedPost(userId, id));
  }

  async duplicatePost(userId: string, id: string) {
    const source = await this.ownedPost(userId, id);
    const copy = this.posts.create({
      userId,
      pageId: source.pageId,
      kind: source.kind,
      title: source.title,
      message: source.message,
      localPath: source.localPath,
      originalFileName: source.originalFileName,
      fileSize: source.fileSize,
      affiliateEnabled: source.affiliateEnabled,
      status: FacebookPostStatus.DRAFT,
      scheduledAt: null,
      publishedAt: null,
      facebookPostId: null,
      uploadPhase: FacebookUploadPhase.NONE,
      uploadSessionId: null,
      uploadOffset: "0",
      sourcePostId: source.id,
      commentResults: [],
      queueJobId: null,
      errorCode: null,
      errorMessage: null,
    });
    await this.posts.save(copy);
    return this.mapPost(await this.ownedPost(userId, copy.id));
  }

  async cancelPost(userId: string, id: string) {
    const post = await this.ownedPost(userId, id);
    if (post.status !== FacebookPostStatus.SCHEDULED) throw new ConflictException("Chỉ hủy được bài đang chờ đăng");
    await this.removeJob(post.id);
    post.status = FacebookPostStatus.CANCELLED;
    post.queueJobId = null;
    await this.posts.save(post);
    return this.mapPost(post);
  }

  async republishPost(userId: string, id: string) {
    const post = await this.ownedPost(userId, id);
    if (![FacebookPostStatus.FAILED, FacebookPostStatus.NEEDS_REVIEW].includes(post.status)) {
      throw new ConflictException("Chỉ đăng lại bài thất bại hoặc cần kiểm tra");
    }
    if (!post.facebookPostId) {
      post.uploadPhase = FacebookUploadPhase.NONE;
      post.uploadSessionId = null;
      post.uploadOffset = "0";
      post.commentResults = [];
    } else if (post.uploadPhase === FacebookUploadPhase.UNCERTAIN) {
      post.uploadPhase = post.uploadSessionId ? FacebookUploadPhase.STARTED : FacebookUploadPhase.CONFIRMED;
    }
    post.errorCode = null;
    post.errorMessage = null;
    post.status = FacebookPostStatus.PUBLISHING;
    await this.posts.save(post);
    await this.queuePost(post, true);
    return this.mapPost(await this.ownedPost(userId, id));
  }

  async listAffiliateLinks(userId: string) {
    const rows = await this.links.find({ where: { userId }, order: { createdAt: "DESC" } });
    return rows.map((row) => this.mapLink(row));
  }

  async createAffiliateLink(userId: string, dto: UpsertAffiliateLinkDto) {
    const saved = await this.links.save(this.links.create(this.linkFields(userId, dto)));
    return this.mapLink(saved);
  }

  async updateAffiliateLink(userId: string, id: string, dto: UpsertAffiliateLinkDto) {
    const row = await this.links.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException("Không tìm thấy link affiliate");
    Object.assign(row, this.linkFields(userId, dto));
    return this.mapLink(await this.links.save(row));
  }

  async deleteAffiliateLink(userId: string, id: string) {
    const row = await this.links.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException("Không tìm thấy link affiliate");
    await this.links.remove(row);
    return { deleted: true };
  }

  async getCommentSettings(userId: string) {
    return this.mapSettings(await this.ensureSettings(userId));
  }

  async saveCommentSettings(userId: string, dto: SaveCommentSettingsDto) {
    const row = await this.ensureSettings(userId);
    row.autoCommentVideo = dto.autoCommentVideo;
    row.autoCommentPost = dto.autoCommentPost;
    row.commentCount = dto.commentCount;
    row.selectionRule = dto.selectionRule;
    row.templates = dto.templates.map((item) => ({ id: item.id, body: item.body, enabled: item.enabled }));
    return this.mapSettings(await this.commentSettings.save(row));
  }

  async listTasks(userId: string, query: FacebookTaskQueryDto) {
    const page = Math.max(1, query.page);
    const limit = Math.min(50, Math.max(1, query.limit));
    const [rows, total] = await this.tasks.findAndCount({
      where: { userId },
      order: { createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        postId: row.postId,
        pageId: row.pageId,
        kind: row.kind,
        attempt: row.attempt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        facebookObjectId: row.facebookObjectId,
        phaseBefore: row.phaseBefore,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        httpStatus: row.httpStatus,
        retryable: row.retryable,
        outcome: row.outcome,
      })),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    };
  }

  private async sweep(): Promise<void> {
    const due = await this.posts.find({
      where: { status: FacebookPostStatus.SCHEDULED, scheduledAt: LessThanOrEqual(new Date()) },
      take: 50,
    });
    for (const post of due) {
      const job = await this.queue.getJob(this.jobId(post.id));
      if (!job) await this.queuePost(post, true);
    }
  }

  private async queuePost(post: FacebookPost, immediate = false): Promise<void> {
    const when = !immediate && post.scheduledAt && post.scheduledAt.getTime() > Date.now() + 5_000 ? post.scheduledAt : null;
    post.status = when ? FacebookPostStatus.SCHEDULED : FacebookPostStatus.PUBLISHING;
    if (!when) post.scheduledAt = post.scheduledAt ?? new Date();
    await this.removeJob(post.id);
    try {
      const job = await this.queue.add(
        "publish",
        { postId: post.id },
        {
          jobId: this.jobId(post.id),
          delay: when ? when.getTime() - Date.now() : 0,
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      post.queueJobId = job.id ? String(job.id) : this.jobId(post.id);
      await this.posts.save(post);
    } catch {
      post.status = FacebookPostStatus.FAILED;
      post.errorCode = "QUEUE_UNAVAILABLE";
      post.errorMessage = "Không thể xếp lịch đăng. Hãy thử lại.";
      await this.posts.save(post);
      throw new ServiceUnavailableException(post.errorMessage);
    }
  }

  private async removeJob(postId: string): Promise<void> {
    const existing = await this.queue.getJob(this.jobId(postId));
    if (!existing) return;
    const state = await existing.getState();
    if (state === "active") return;
    await existing.remove();
  }

  private jobId(postId: string): string {
    return `facebook-post-${postId}`;
  }

  private async maybeStoreMedia(userId: string, kind: FacebookContentKind, sourcePath?: string) {
    if (!sourcePath?.trim()) return null;
    if (kind === FacebookContentKind.POST) return null;
    const local = validateFacebookMedia(sourcePath.trim(), kind);
    const root = resolve(process.env.FACEBOOK_MEDIA_WORK_ROOT ?? "uploads/facebook");
    const directory = join(root, userId);
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, `${randomUUID()}${extname(local.fileName).toLowerCase()}`);
    await copyFile(local.realPath, destination);
    return { localPath: destination, originalFileName: local.fileName, fileSize: String(local.sizeBytes) };
  }

  private assertPublishable(publish: boolean, kind: FacebookContentKind, message?: string | null, localPath?: string | null): void {
    if (!publish) return;
    if (kind === FacebookContentKind.POST && !message?.trim()) throw new BadRequestException("Bài viết cần có nội dung");
    if (kind !== FacebookContentKind.POST && !localPath) throw new BadRequestException("Cần chọn tệp trước khi đăng");
  }

  private linkFields(userId: string, dto: UpsertAffiliateLinkDto) {
    return {
      userId,
      name: dto.name.trim(),
      affiliateUrl: assertHttpsUrl(dto.affiliateUrl, "Link affiliate"),
      destinationUrl: dto.destinationUrl?.trim() ? assertHttpsUrl(dto.destinationUrl, "Link đích") : null,
      productGroup: dto.productGroup?.trim() ?? "",
      keywords: (dto.keywords ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 30),
      pageIds: dto.pageIds ?? [],
      status: dto.status ?? FacebookAffiliateStatus.ACTIVE,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
    };
  }

  private async ensureSettings(userId: string): Promise<FacebookCommentSettings> {
    const existing = await this.commentSettings.findOne({ where: { userId } });
    if (existing) return existing;
    return this.commentSettings.save(
      this.commentSettings.create({
        userId,
        autoCommentVideo: false,
        autoCommentPost: false,
        commentCount: 1,
        selectionRule: FacebookSelectionRule.RANDOM,
        sequentialCursor: 0,
        templates: [{ id: randomUUID(), body: "{name}\n{link}", enabled: true }],
      }),
    );
  }

  private async ownedPage(userId: string, pageId: string): Promise<FacebookPage> {
    // Check locally if page exists in tool or platform
    let page = await this.pages.findOne({ where: { id: pageId } });
    if (!page) {
      // Sync from platform if needed
      try {
        const platPage = await this.platformFb.getPageById(userId, pageId);
        page = this.pages.create({
          id: platPage.id,
          pageId: platPage.pageId,
          name: platPage.name,
          pictureUrl: platPage.pictureUrl,
          canPublish: platPage.canPublish,
          canComment: platPage.canComment,
        });
        await this.pages.save(page);
      } catch {
        throw new NotFoundException("Không tìm thấy Page");
      }
    }
    return page;
  }

  private async ownedPost(userId: string, id: string): Promise<FacebookPost> {
    const row = await this.posts.findOne({ where: { id, userId }, relations: { page: true } });
    if (!row) throw new NotFoundException("Không tìm thấy bài đăng");
    return row;
  }

  private mapPost(row: FacebookPost) {
    return {
      id: row.id,
      pageId: row.pageId,
      pageName: row.page?.name ?? null,
      pageGraphId: row.page?.pageId ?? null,
      kind: row.kind,
      title: row.title,
      message: row.message,
      originalFileName: row.originalFileName,
      fileSize: row.fileSize ? Number(row.fileSize) : null,
      status: row.status,
      scheduledAt: row.scheduledAt,
      publishedAt: row.publishedAt,
      facebookPostId: row.facebookPostId,
      uploadPhase: row.uploadPhase,
      affiliateEnabled: row.affiliateEnabled,
      sourcePostId: row.sourcePostId,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      canEdit: [FacebookPostStatus.DRAFT, FacebookPostStatus.SCHEDULED].includes(row.status),
      canCancel: row.status === FacebookPostStatus.SCHEDULED,
      canRepublish: [FacebookPostStatus.FAILED, FacebookPostStatus.NEEDS_REVIEW].includes(row.status),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapLink(row: FacebookAffiliateLink) {
    return {
      id: row.id,
      name: row.name,
      affiliateUrl: row.affiliateUrl,
      destinationUrl: row.destinationUrl,
      productGroup: row.productGroup,
      keywords: row.keywords,
      pageIds: row.pageIds,
      status: row.status,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      createdAt: row.createdAt,
    };
  }

  private mapSettings(row: FacebookCommentSettings) {
    return {
      autoCommentVideo: row.autoCommentVideo,
      autoCommentPost: row.autoCommentPost,
      commentCount: row.commentCount,
      selectionRule: row.selectionRule,
      sequentialCursor: row.sequentialCursor,
      templates: row.templates,
    };
  }
}

