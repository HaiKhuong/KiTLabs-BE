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
import axios from "axios";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { copyFile } from "fs/promises";
import { extname, join, resolve } from "path";
import { In, LessThanOrEqual, Repository } from "typeorm";

import { decryptSecret, encryptSecret } from "../../common/config/settings-crypto";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { FacebookAccount } from "./facebook-account.entity";
import { FacebookAffiliateLink } from "./facebook-affiliate-link.entity";
import { FacebookCommentSettings } from "./facebook-comment-settings.entity";
import { assertHttpsUrl, validateFacebookMedia } from "./facebook-media.validation";
import { FacebookPage } from "./facebook-page.entity";
import { FacebookPost } from "./facebook-post.entity";
import { FacebookProviderAdapter, FacebookProviderError } from "./facebook-provider.adapter";
import { FacebookOAuthStateService } from "./facebook-oauth-state.service";
import { FacebookTaskLog } from "./facebook-task-log.entity";
import {
  CreateFacebookPostDto,
  FACEBOOK_PUBLISH_QUEUE,
  FACEBOOK_REQUIRED_SCOPES,
  FacebookAccountStatus,
  FacebookAffiliateStatus,
  FacebookContentKind,
  FacebookPageStatus,
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
    @InjectRepository(FacebookAccount, "tool") private readonly accounts: Repository<FacebookAccount>,
    @InjectRepository(FacebookPage, "tool") private readonly pages: Repository<FacebookPage>,
    @InjectRepository(FacebookPost, "tool") private readonly posts: Repository<FacebookPost>,
    @InjectRepository(FacebookAffiliateLink, "tool") private readonly links: Repository<FacebookAffiliateLink>,
    @InjectRepository(FacebookCommentSettings, "tool") private readonly commentSettings: Repository<FacebookCommentSettings>,
    @InjectRepository(FacebookTaskLog, "tool") private readonly tasks: Repository<FacebookTaskLog>,
    @InjectQueue(FACEBOOK_PUBLISH_QUEUE) private readonly queue: Queue,
    private readonly provider: FacebookProviderAdapter,
    private readonly oauthStates: FacebookOAuthStateService,
    private readonly realtime: ToolsRealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => this.logger.warn(`Facebook sweep failed: ${error instanceof Error ? error.message : "unknown"}`));
    }, 120_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async connect(userId: string): Promise<{ authorizationUrl: string }> {
    this.assertConfigured();
    const state = await this.oauthStates.create(userId);
    return { authorizationUrl: this.provider.authorizationUrl(state) };
  }

  async completeOAuth(input: { state?: string; code?: string; error?: string }): Promise<{ userId: string; ticket: string }> {
    if (input.error) throw new BadRequestException("Facebook từ chối đăng nhập");
    if (!input.state || !input.code) throw new BadRequestException("OAuth callback không hợp lệ");
    const userId = await this.oauthStates.consume(input.state);
    if (!userId) throw new BadRequestException("Phiên đăng nhập Facebook đã hết hạn");
    const shortLived = await this.provider.exchangeCode(input.code);
    const longLived = await this.provider.exchangeLongLived(shortLived.accessToken);
    const debug = await this.provider.debugToken(longLived.accessToken);
    const profile = await this.provider.getProfile(longLived.accessToken);
    const missing = FACEBOOK_REQUIRED_SCOPES.filter((scope) => !debug.scopes.includes(scope));
    let account = await this.accounts.findOne({ where: { userId } });
    if (!account) account = this.accounts.create({ userId, fbUserId: profile.id });
    account.fbUserId = profile.id;
    account.name = profile.name;
    account.pictureUrl = profile.pictureUrl;
    account.accessTokenEncrypted = encryptSecret(longLived.accessToken);
    account.tokenExpiresAt = longLived.expiresIn ? new Date(Date.now() + longLived.expiresIn * 1000) : debug.expiresAt;
    account.scopes = debug.scopes;
    account.status = missing.length ? FacebookAccountStatus.MISSING_PERMISSION : FacebookAccountStatus.CONNECTED;
    account.lastCheckedAt = new Date();
    account.lastCheckMessage = missing.length ? `Thiếu quyền: ${missing.join(", ")}` : null;
    await this.accounts.save(account);
    await this.syncPages(account, longLived.accessToken);
    this.realtime.notifyUser(userId, "facebook.account.updated", { accountId: account.id });
    const pages = await this.pages.find({ where: { accountId: account.id } });
    const ticket = await this.oauthStates.createHandoff({
      provider: "facebook",
      account: {
        fbUserId: account.fbUserId, name: account.name, pictureUrl: account.pictureUrl,
        accessToken: longLived.accessToken, tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
        scopes: account.scopes, status: account.status,
      },
      pages: pages.map((page) => ({
        pageId: page.pageId, name: page.name, pictureUrl: page.pictureUrl,
        pageAccessToken: page.pageAccessTokenEncrypted ? decryptSecret(page.pageAccessTokenEncrypted) : null,
        tasks: page.tasks, canPublish: page.canPublish, canComment: page.canComment, status: page.status,
      })),
    });
    return { userId, ticket };
  }

  async redeemHandoff(ticket: string) {
    const payload = await this.oauthStates.consumeHandoff(ticket);
    if (!payload || payload.provider !== "facebook") throw new BadRequestException("OAuth handoff is invalid or expired");
    return payload;
  }

  async importHandoff(userId: string, apiServerUrl: string, ticket: string) {
    const base = this.validateApiServerUrl(apiServerUrl);
    const response = await axios.post(`${base}/api/facebook/handoff/redeem`, { ticket }, { timeout: 15_000 });
    const payload = (response.data?.data ?? response.data) as any;
    if (payload?.provider !== "facebook" || !payload.account?.accessToken) throw new BadRequestException("Invalid Facebook handoff payload");
    let account = await this.accounts.findOne({ where: { userId } });
    if (!account) account = this.accounts.create({ userId, fbUserId: String(payload.account.fbUserId) });
    Object.assign(account, {
      fbUserId: String(payload.account.fbUserId), name: payload.account.name ?? null,
      pictureUrl: payload.account.pictureUrl ?? null, accessTokenEncrypted: encryptSecret(String(payload.account.accessToken)),
      tokenExpiresAt: payload.account.tokenExpiresAt ? new Date(payload.account.tokenExpiresAt) : null,
      scopes: Array.isArray(payload.account.scopes) ? payload.account.scopes.map(String) : [],
      status: payload.account.status ?? FacebookAccountStatus.CONNECTED, lastCheckedAt: new Date(), lastCheckMessage: null,
    });
    account = await this.accounts.save(account);
    for (const item of Array.isArray(payload.pages) ? payload.pages : []) {
      let page = await this.pages.findOne({ where: { accountId: account.id, pageId: String(item.pageId) } });
      if (!page) page = this.pages.create({ accountId: account.id, pageId: String(item.pageId), name: String(item.name ?? "") });
      Object.assign(page, {
        name: String(item.name ?? ""), pictureUrl: item.pictureUrl ?? null,
        pageAccessTokenEncrypted: item.pageAccessToken ? encryptSecret(String(item.pageAccessToken)) : null,
        tasks: Array.isArray(item.tasks) ? item.tasks.map(String) : [], canPublish: Boolean(item.canPublish),
        canComment: Boolean(item.canComment), status: item.status ?? FacebookPageStatus.ACTIVE, lastCheckedAt: new Date(),
      });
      await this.pages.save(page);
    }
    this.realtime.notifyUser(userId, "facebook.account.updated", { accountId: account.id });
    return this.connection(userId);
  }

  private validateApiServerUrl(raw: string): string {
    let url: URL;
    try { url = new URL(String(raw || "").trim()); } catch { throw new BadRequestException("Invalid API Server URL"); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      throw new BadRequestException("API Server must use HTTPS");
    }
    return url.toString().replace(/\/+$/, "").replace(/\/api$/, "");
  }

  async disconnect(userId: string): Promise<{ disconnected: true }> {
    const account = await this.accounts.findOne({ where: { userId } });
    if (!account) return { disconnected: true };
    account.status = FacebookAccountStatus.REVOKED;
    account.accessTokenEncrypted = null;
    account.lastCheckMessage = "Đã ngắt kết nối";
    account.lastCheckedAt = new Date();
    await this.accounts.save(account);
    const pages = await this.pages.find({ where: { accountId: account.id } });
    for (const page of pages) {
      page.status = FacebookPageStatus.LOST_ACCESS;
      page.canPublish = false;
      page.canComment = false;
      page.pageAccessTokenEncrypted = null;
      await this.pages.save(page);
      await this.blockScheduled(page.id, "ACCOUNT_REVOKED", "Tài khoản Facebook đã ngắt kết nối.");
    }
    this.realtime.notifyUser(userId, "facebook.account.updated", { accountId: account.id });
    return { disconnected: true };
  }

  async connection(userId: string) {
    const account = await this.accounts.findOne({ where: { userId } });
    if (!account) {
      return { connected: false, account: null, requiredScopes: FACEBOOK_REQUIRED_SCOPES, missingScopes: [...FACEBOOK_REQUIRED_SCOPES], pages: [] };
    }
    const pages = await this.pages.find({ where: { accountId: account.id }, order: { name: "ASC" } });
    const missingScopes = FACEBOOK_REQUIRED_SCOPES.filter((scope) => !account.scopes.includes(scope));
    return {
      connected: account.status === FacebookAccountStatus.CONNECTED && missingScopes.length === 0,
      account: this.mapAccount(account),
      requiredScopes: FACEBOOK_REQUIRED_SCOPES,
      missingScopes,
      pages: pages.map((page) => this.mapPage(page)),
    };
  }

  async checkConnection(userId: string) {
    const account = await this.ownedAccount(userId);
    if (!account.accessTokenEncrypted) {
      account.status = FacebookAccountStatus.REVOKED;
      account.lastCheckMessage = "Chưa có token. Hãy kết nối lại.";
      account.lastCheckedAt = new Date();
      await this.accounts.save(account);
      return this.connection(userId);
    }
    try {
      let token = decryptSecret(account.accessTokenEncrypted);
      if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() - Date.now() < 7 * 86_400_000) {
        const renewed = await this.provider.exchangeLongLived(token);
        token = renewed.accessToken;
        account.accessTokenEncrypted = encryptSecret(token);
        account.tokenExpiresAt = renewed.expiresIn ? new Date(Date.now() + renewed.expiresIn * 1000) : account.tokenExpiresAt;
      }
      const debug = await this.provider.debugToken(token);
      const missing = FACEBOOK_REQUIRED_SCOPES.filter((scope) => !debug.scopes.includes(scope));
      account.scopes = debug.scopes;
      account.tokenExpiresAt = debug.expiresAt ?? account.tokenExpiresAt;
      account.lastCheckedAt = new Date();
      if (!debug.isValid) {
        account.status = FacebookAccountStatus.REVOKED;
        account.lastCheckMessage = "Token không còn hiệu lực";
      } else if (missing.length) {
        account.status = FacebookAccountStatus.MISSING_PERMISSION;
        account.lastCheckMessage = `Thiếu quyền: ${missing.join(", ")}`;
      } else if (debug.expiresAt && debug.expiresAt.getTime() <= Date.now()) {
        account.status = FacebookAccountStatus.EXPIRED;
        account.lastCheckMessage = "Token đã hết hạn";
      } else {
        account.status = FacebookAccountStatus.CONNECTED;
        account.lastCheckMessage = null;
        const profile = await this.provider.getProfile(token);
        account.name = profile.name;
        account.pictureUrl = profile.pictureUrl;
      }
      await this.accounts.save(account);
      if (account.status === FacebookAccountStatus.CONNECTED) {
        await this.syncPages(account, token);
      } else {
        const pages = await this.pages.find({ where: { accountId: account.id } });
        for (const page of pages) await this.blockScheduled(page.id, account.status, account.lastCheckMessage ?? "Mất quyền Facebook");
      }
    } catch (error) {
      if (error instanceof FacebookProviderError && error.permission) {
        account.status = FacebookAccountStatus.REVOKED;
        account.lastCheckMessage = "Facebook từ chối token";
        account.lastCheckedAt = new Date();
        await this.accounts.save(account);
        const pages = await this.pages.find({ where: { accountId: account.id } });
        for (const page of pages) await this.blockScheduled(page.id, "TOKEN_REJECTED", account.lastCheckMessage);
      } else if (!(error instanceof FacebookProviderError && (error.retryable || error.uncertain))) {
        throw error;
      }
    }
    this.realtime.notifyUser(userId, "facebook.account.updated", { accountId: account.id });
    return this.connection(userId);
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
    await this.assertPagesOwned(userId, dto.pageIds ?? []);
    const saved = await this.links.save(this.links.create(this.linkFields(userId, dto)));
    return this.mapLink(saved);
  }

  async updateAffiliateLink(userId: string, id: string, dto: UpsertAffiliateLinkDto) {
    const row = await this.links.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException("Không tìm thấy link affiliate");
    await this.assertPagesOwned(userId, dto.pageIds ?? []);
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
    const accounts = await this.accounts.find({ where: { status: FacebookAccountStatus.CONNECTED } });
    for (const account of accounts) {
      if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= Date.now()) {
        account.status = FacebookAccountStatus.EXPIRED;
        account.lastCheckMessage = "Token đã hết hạn";
        account.lastCheckedAt = new Date();
        await this.accounts.save(account);
        const pages = await this.pages.find({ where: { accountId: account.id } });
        for (const page of pages) await this.blockScheduled(page.id, "TOKEN_EXPIRED", account.lastCheckMessage);
        this.realtime.notifyUser(account.userId, "facebook.account.updated", { accountId: account.id });
      }
    }
  }

  private async syncPages(account: FacebookAccount, userToken: string): Promise<void> {
    const grants = await this.provider.listPages(userToken);
    const existing = await this.pages.find({ where: { accountId: account.id } });
    const seen = new Set<string>();
    for (const grant of grants) {
      seen.add(grant.id);
      const tasks = grant.tasks ?? [];
      const canPublish = tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE");
      let row = existing.find((page) => page.pageId === grant.id);
      if (!row) row = this.pages.create({ accountId: account.id, pageId: grant.id, name: grant.name });
      row.name = grant.name;
      row.pictureUrl = grant.pictureUrl;
      row.pageAccessTokenEncrypted = encryptSecret(grant.accessToken);
      row.tasks = tasks;
      row.canPublish = canPublish;
      row.canComment = canPublish || tasks.includes("MODERATE");
      row.status = canPublish ? FacebookPageStatus.ACTIVE : FacebookPageStatus.LOST_ACCESS;
      row.lastCheckedAt = new Date();
      await this.pages.save(row);
      if (!canPublish) await this.blockScheduled(row.id, "PAGE_PUBLISH_DENIED", "Page không còn quyền đăng bài.");
    }
    for (const row of existing) {
      if (seen.has(row.pageId)) continue;
      row.status = FacebookPageStatus.LOST_ACCESS;
      row.canPublish = false;
      row.canComment = false;
      row.lastCheckedAt = new Date();
      await this.pages.save(row);
      await this.blockScheduled(row.id, "PAGE_ACCESS_LOST", "Page không còn trong tài khoản Facebook.");
    }
  }

  private async blockScheduled(pageId: string, code: string, message: string): Promise<void> {
    const rows = await this.posts.find({ where: { pageId, status: In([FacebookPostStatus.SCHEDULED]) } });
    for (const post of rows) {
      await this.removeJob(post.id);
      post.status = FacebookPostStatus.BLOCKED;
      post.errorCode = code;
      post.errorMessage = message;
      post.queueJobId = null;
      await this.posts.save(post);
      this.realtime.notifyUser(post.userId, "facebook.post.updated", { postId: post.id, status: post.status });
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

  private async assertPagesOwned(userId: string, pageIds: string[]): Promise<void> {
    if (pageIds.length === 0) return;
    const account = await this.accounts.findOne({ where: { userId } });
    if (!account) throw new BadRequestException("Hãy kết nối Facebook trước khi gắn Page");
    const count = await this.pages.count({ where: { accountId: account.id, pageId: In(pageIds) } });
    if (count !== new Set(pageIds).size) throw new BadRequestException("Page áp dụng không thuộc tài khoản đã kết nối");
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

  private async ownedAccount(userId: string): Promise<FacebookAccount> {
    const row = await this.accounts.findOne({ where: { userId } });
    if (!row) throw new NotFoundException("Chưa kết nối Facebook");
    return row;
  }

  private async ownedPage(userId: string, pageId: string): Promise<FacebookPage> {
    const account = await this.ownedAccount(userId);
    const page = await this.pages.findOne({ where: { id: pageId, accountId: account.id } });
    if (!page) throw new NotFoundException("Không tìm thấy Page");
    return page;
  }

  private async ownedPost(userId: string, id: string): Promise<FacebookPost> {
    const row = await this.posts.findOne({ where: { id, userId }, relations: { page: true } });
    if (!row) throw new NotFoundException("Không tìm thấy bài đăng");
    return row;
  }

  private mapAccount(row: FacebookAccount) {
    return {
      id: row.id,
      fbUserId: row.fbUserId,
      name: row.name,
      pictureUrl: row.pictureUrl,
      status: row.status,
      scopes: row.scopes,
      tokenExpiresAt: row.tokenExpiresAt,
      lastCheckedAt: row.lastCheckedAt,
      lastCheckMessage: row.lastCheckMessage,
    };
  }

  private mapPage(row: FacebookPage) {
    return {
      id: row.id,
      pageId: row.pageId,
      name: row.name,
      pictureUrl: row.pictureUrl,
      tasks: row.tasks,
      canPublish: row.canPublish,
      canComment: row.canComment,
      status: row.status,
      lastCheckedAt: row.lastCheckedAt,
    };
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

  private assertConfigured(): void {
    for (const name of ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "SETTINGS_ENCRYPTION_KEY"]) {
      if (!process.env[name]?.trim()) throw new ServiceUnavailableException("Facebook integration is not configured");
    }
  }
}
