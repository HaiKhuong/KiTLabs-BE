import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { mkdirSync } from "fs";
import { copyFile } from "fs/promises";
import { extname, join, resolve } from "path";
import { DataSource, Repository } from "typeorm";
import { randomUUID } from "crypto";

import { decryptSecret, encryptSecret } from "../../common/config/settings-crypto";
import { TikTokAccount } from "./tiktok-account.entity";
import { TikTokOAuthStateService } from "./tiktok-oauth-state.service";
import { TikTokProviderAdapter, TikTokProviderError } from "./tiktok-provider.adapter";
import {
  CommercialDisclosure,
  ImportLocalVideoDto,
  mapCommercialDisclosure,
  PublishTikTokVideoDto,
  TikTokAccountStatus,
  TikTokVideoListQueryDto,
  TikTokVideoStatus,
  VideoHistoryQueryDto,
} from "./tiktok.types";
import { TikTokVideo } from "./tiktok-video.entity";
import { inspectVideo, validateKiTLabsUpload, validateTikTokVideo } from "./tiktok-video.validation";

export const TIKTOK_PUBLISH_QUEUE = "tiktok-publish";

@Injectable()
export class TikTokService {
  private readonly logger = new Logger(TikTokService.name);

  constructor(
    @InjectRepository(TikTokAccount, "tool") private readonly accounts: Repository<TikTokAccount>,
    @InjectRepository(TikTokVideo, "tool") private readonly videos: Repository<TikTokVideo>,
    @InjectQueue(TIKTOK_PUBLISH_QUEUE) private readonly queue: Queue,
    @InjectDataSource("tool") private readonly toolDataSource: DataSource,
    private readonly provider: TikTokProviderAdapter,
    private readonly oauthStates: TikTokOAuthStateService,
  ) {}

  async connect(userId: string): Promise<{ authorizationUrl: string }> {
    this.assertConfigured();
    const state = await this.oauthStates.create(userId);
    return { authorizationUrl: this.provider.authorizationUrl(state) };
  }

  async completeOAuth(input: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<{ userId: string; account: ReturnType<TikTokService["mapAccount"]> }> {
    if (input.error) throw new BadRequestException("TikTok authorization was denied");
    if (!input.state || !input.code) throw new BadRequestException("Invalid OAuth callback");
    const userId = await this.oauthStates.consume(input.state);
    if (!userId) throw new BadRequestException("OAuth state is invalid or expired");
    try {
      const tokens = await this.provider.exchangeCode(input.code);
      const granted = new Set(
        String(tokens.scope ?? "")
          .split(",")
          .filter(Boolean),
      );
      for (const required of ["user.info.basic", "video.publish", "video.list"]) {
        if (!granted.has(required)) throw new BadRequestException("Required TikTok scopes were not granted");
      }
      const profile = await this.provider.getUser(tokens.access_token);
      if (!profile.openId || profile.openId !== tokens.open_id) {
        throw new BadRequestException("TikTok account identity could not be verified");
      }
      const creator = await this.provider.creatorInfo(tokens.access_token);
      profile.username = creator.creator_username
        ? String(creator.creator_username)
        : profile.username;
      profile.displayName = creator.creator_nickname
        ? String(creator.creator_nickname)
        : profile.displayName;
      profile.avatarUrl = creator.creator_avatar_url
        ? String(creator.creator_avatar_url)
        : profile.avatarUrl;
      const saved = await this.toolDataSource.transaction(async (manager) => {
        await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tiktok-account:${userId}`]);
        const repository = manager.getRepository(TikTokAccount);
        const existing = await repository.findOne({ where: { userId, openId: profile.openId } });
        if (!existing && (await repository.count({ where: { userId } })) >= 2) {
          throw new ConflictException("Chỉ có thể kết nối tối đa 2 tài khoản TikTok.");
        }
        const account = existing ?? repository.create({ userId, openId: profile.openId, isActive: false });
        Object.assign(account, {
          ...profile,
          accessTokenEncrypted: encryptSecret(tokens.access_token),
          refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
          accessTokenExpiresAt: new Date(Date.now() + Number(tokens.expires_in) * 1000),
          refreshTokenExpiresAt: new Date(Date.now() + Number(tokens.refresh_expires_in) * 1000),
          scopes: [...granted],
          status: TikTokAccountStatus.CONNECTED,
        });
        if (!(await repository.exists({ where: { userId, isActive: true } }))) account.isActive = true;
        return repository.save(account);
      });
      return { userId, account: this.mapAccount(saved) };
    } catch (error) {
      this.throwSanitized(error);
    }
  }

  async listAccounts(userId: string) {
    const rows = await this.accounts.find({ where: { userId }, order: { createdAt: "ASC" } });
    return rows.map((row) => this.mapAccount(row));
  }

  async refreshAccount(userId: string, accountId: string) {
    const account = await this.ownedAccount(userId, accountId);
    await this.rotateTokens(account);
    const creator = await this.provider.creatorInfo(
      decryptSecret(account.accessTokenEncrypted),
    );
    account.username = creator.creator_username
      ? String(creator.creator_username)
      : account.username;
    account.displayName = creator.creator_nickname
      ? String(creator.creator_nickname)
      : account.displayName;
    account.avatarUrl = creator.creator_avatar_url
      ? String(creator.creator_avatar_url)
      : account.avatarUrl;
    await this.accounts.save(account);
    return this.mapAccount(account);
  }

  async disconnect(userId: string, accountId: string): Promise<{ disconnected: true }> {
    const account = await this.ownedAccount(userId, accountId);
    try {
      await this.provider.revoke(decryptSecret(account.accessTokenEncrypted));
    } catch (error) {
      if (error instanceof TikTokProviderError) {
        this.logger.warn(`TikTok revoke failed code=${error.code} logId=${error.logId ?? "none"}`);
      }
    }
    await this.accounts.remove(account);
    if (account.isActive) {
      const next = await this.accounts.findOne({ where: { userId }, order: { createdAt: "ASC" } });
      if (next) {
        next.isActive = true;
        await this.accounts.save(next);
      }
    }
    return { disconnected: true };
  }

  async creatorInfo(userId: string, accountId: string): Promise<Record<string, unknown>> {
    const account = await this.ownedAccount(userId, accountId);
    try {
      return await this.provider.creatorInfo(await this.validAccessToken(account));
    } catch (error) {
      this.throwSanitized(error);
    }
  }

  async importLocalVideo(userId: string, dto: ImportLocalVideoDto): Promise<ReturnType<TikTokService["mapVideo"]>> {
    const local = validateKiTLabsUpload(dto.sourcePath.trim());
    const metadata = inspectVideo(local.realPath, local.sizeBytes);
    validateTikTokVideo(metadata);
    const extension = extname(local.fileName).toLowerCase();
    const root = resolve(process.env.TIKTOK_VIDEO_WORK_ROOT ?? "uploads/tiktok");
    const directory = join(root, userId);
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, `${randomUUID()}${extension}`);
    await copyFile(local.realPath, destination);
    const saved = await this.videos.save(
      this.videos.create({
        userId,
        accountId: null,
        localPath: destination,
        originalFileName: local.fileName,
        fileSize: String(local.sizeBytes),
        metadata,
        status: TikTokVideoStatus.IMPORTED,
        caption: null,
        privacyLevel: null,
        commercialDisclosure: CommercialDisclosure.NONE,
        isAigc: false,
        disableComment: true,
        disableDuet: true,
        disableStitch: true,
        publishId: null,
        providerPostId: null,
        uploadedBytes: "0",
        queueJobId: null,
        errorCode: null,
        errorMessage: null,
        publishedAt: null,
      }),
    );
    return this.mapVideo(saved);
  }

  async publish(userId: string, videoId: string, dto: PublishTikTokVideoDto) {
    const video = await this.ownedVideo(userId, videoId);
    if (![TikTokVideoStatus.IMPORTED, TikTokVideoStatus.FAILED].includes(video.status)) {
      throw new ConflictException("Video cannot be published from its current state");
    }
    if (dto.privacyLevel !== "SELF_ONLY") throw new BadRequestException("MVP chỉ hỗ trợ quyền riêng tư SELF_ONLY.");
    if ([CommercialDisclosure.BRANDED_CONTENT, CommercialDisclosure.BOTH].includes(dto.commercialDisclosure)) {
      throw new BadRequestException("Nội dung được tài trợ không khả dụng với SELF_ONLY trong MVP.");
    }
    if (!dto.musicUsageConfirmed) throw new BadRequestException("Music Usage Confirmation is required");
    const account = await this.ownedAccount(userId, dto.accountId);
    const creator = await this.creatorInfo(userId, account.id);
    const privacyOptions = Array.isArray(creator.privacy_level_options)
      ? creator.privacy_level_options.map(String)
      : [];
    if (!privacyOptions.includes("SELF_ONLY"))
      throw new ForbiddenException("Tài khoản hiện không cho phép đăng SELF_ONLY.");
    validateTikTokVideo(video.metadata, Number(creator.max_video_post_duration_sec ?? 0) || undefined);
    if (creator.comment_disabled === true && dto.disableComment === false)
      throw new BadRequestException("Comments are disabled for this creator");
    if (creator.duet_disabled === true && dto.disableDuet === false)
      throw new BadRequestException("Duet is disabled for this creator");
    if (creator.stitch_disabled === true && dto.disableStitch === false)
      throw new BadRequestException("Stitch is disabled for this creator");

    Object.assign(video, {
      accountId: account.id,
      caption: dto.caption,
      privacyLevel: "SELF_ONLY",
      commercialDisclosure: dto.commercialDisclosure,
      isAigc: dto.isAigc,
      disableComment: dto.disableComment,
      disableDuet: dto.disableDuet,
      disableStitch: dto.disableStitch,
      status: TikTokVideoStatus.QUEUED,
      errorCode: null,
      errorMessage: null,
      publishId: null,
      providerPostId: null,
      uploadedBytes: "0",
    });
    await this.videos.save(video);
    try {
      const job = await this.queue.add(
        "direct-post",
        {
          videoId: video.id,
          disableComment: dto.disableComment,
          disableDuet: dto.disableDuet,
          disableStitch: dto.disableStitch,
        },
        { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 100, removeOnFail: 100 },
      );
      video.queueJobId = job.id ? String(job.id) : null;
      await this.videos.save(video);
    } catch {
      video.status = TikTokVideoStatus.FAILED;
      video.errorCode = "QUEUE_UNAVAILABLE";
      video.errorMessage = "Không thể xếp hàng đăng video. Vui lòng thử lại.";
      await this.videos.save(video);
      throw new ServiceUnavailableException(video.errorMessage);
    }
    return this.mapVideo(video);
  }

  async retry(userId: string, videoId: string) {
    const video = await this.ownedVideo(userId, videoId);
    if (video.status !== TikTokVideoStatus.FAILED || !video.accountId) {
      throw new ConflictException("Only failed publish attempts can be retried");
    }
    if (
      video.errorCode &&
      [
        "spam_risk_too_many_posts",
        "spam_risk_user_banned_from_posting",
        "spam_risk",
        "spam_risk_text",
        "content_violations",
        "access_token_invalid",
        "auth_removed",
      ].includes(video.errorCode)
    ) {
      throw new ConflictException("This provider failure is not retryable");
    }
    const dto = Object.assign(new PublishTikTokVideoDto(), {
      accountId: video.accountId,
      caption: video.caption ?? "",
      privacyLevel: "SELF_ONLY",
      commercialDisclosure: video.commercialDisclosure,
      musicUsageConfirmed: true,
      isAigc: video.isAigc,
      disableComment: video.disableComment,
      disableDuet: video.disableDuet,
      disableStitch: video.disableStitch,
    });
    return this.publish(userId, videoId, dto);
  }

  async listHistory(userId: string, query: VideoHistoryQueryDto) {
    const page = Math.max(1, query.page);
    const limit = Math.min(50, Math.max(1, query.limit));
    const where = { userId, ...(query.status ? { status: query.status } : {}) };
    const [rows, total] = await this.videos.findAndCount({
      where,
      order: { createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items: rows.map((row) => this.mapVideo(row)), total, page, limit, hasMore: page * limit < total };
  }

  async getHistory(userId: string, videoId: string) {
    return this.mapVideo(await this.ownedVideo(userId, videoId));
  }

  async listProviderVideos(userId: string, accountId: string, query: TikTokVideoListQueryDto) {
    const account = await this.ownedAccount(userId, accountId);
    try {
      return await this.provider.listVideos(await this.validAccessToken(account), query.maxCount, query.cursor);
    } catch (error) {
      this.throwSanitized(error);
    }
  }

  async ownedVideo(userId: string, id: string): Promise<TikTokVideo> {
    const row = await this.videos.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException("TikTok video not found");
    return row;
  }

  async ownedAccount(userId: string, id: string): Promise<TikTokAccount> {
    const row = await this.accounts.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException("TikTok account not found");
    return row;
  }

  async validAccessToken(account: TikTokAccount): Promise<string> {
    if (account.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
      return decryptSecret(account.accessTokenEncrypted);
    }
    await this.rotateTokens(account);
    return decryptSecret(account.accessTokenEncrypted);
  }

  private async rotateTokens(account: TikTokAccount): Promise<void> {
    if (account.refreshTokenExpiresAt.getTime() <= Date.now()) {
      account.status = TikTokAccountStatus.EXPIRED;
      await this.accounts.save(account);
      throw new ForbiddenException("TikTok authorization expired. Please reconnect.");
    }
    try {
      const token = await this.provider.refreshToken(decryptSecret(account.refreshTokenEncrypted));
      account.accessTokenEncrypted = encryptSecret(token.access_token);
      account.refreshTokenEncrypted = encryptSecret(token.refresh_token);
      account.accessTokenExpiresAt = new Date(Date.now() + Number(token.expires_in) * 1000);
      account.refreshTokenExpiresAt = new Date(Date.now() + Number(token.refresh_expires_in) * 1000);
      account.scopes = String(token.scope ?? "")
        .split(",")
        .filter(Boolean);
      account.status = TikTokAccountStatus.CONNECTED;
      await this.accounts.save(account);
    } catch (error) {
      this.throwSanitized(error);
    }
  }

  mapAccount(row: TikTokAccount) {
    return {
      id: row.id,
      openId: row.openId,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      scopes: row.scopes,
      status: row.status,
      isActive: row.isActive,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      refreshTokenExpiresAt: row.refreshTokenExpiresAt,
      createdAt: row.createdAt,
    };
  }

  mapVideo(row: TikTokVideo) {
    return {
      id: row.id,
      accountId: row.accountId,
      originalFileName: row.originalFileName,
      fileSize: Number(row.fileSize),
      metadata: row.metadata,
      status: row.status,
      caption: row.caption,
      privacyLevel: row.privacyLevel,
      commercialDisclosure: row.commercialDisclosure,
      isAigc: row.isAigc,
      disableComment: row.disableComment,
      disableDuet: row.disableDuet,
      disableStitch: row.disableStitch,
      publishId: row.publishId,
      providerPostId: row.providerPostId,
      uploadedBytes: Number(row.uploadedBytes),
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      canRetry:
        row.status === TikTokVideoStatus.FAILED &&
        ![
          "spam_risk_too_many_posts",
          "spam_risk_user_banned_from_posting",
          "spam_risk",
          "spam_risk_text",
          "content_violations",
          "access_token_invalid",
          "auth_removed",
        ].includes(row.errorCode ?? ""),
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private assertConfigured(): void {
    for (const name of [
      "TIKTOK_CLIENT_KEY",
      "TIKTOK_CLIENT_SECRET",
      "TIKTOK_REDIRECT_URI",
      "SETTINGS_ENCRYPTION_KEY",
    ]) {
      if (!process.env[name]?.trim()) throw new ServiceUnavailableException("TikTok integration is not configured");
    }
  }

  private throwSanitized(error: unknown): never {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof ForbiddenException
    )
      throw error;
    if (error instanceof TikTokProviderError) {
      this.logger.warn(`TikTok request failed code=${error.code} logId=${error.logId ?? "none"}`);
      if (error.retryable)
        throw new ServiceUnavailableException({
          code: "TIKTOK_TEMPORARILY_UNAVAILABLE",
          message: "TikTok tạm thời không khả dụng.",
        });
      throw new BadRequestException({
        code: "TIKTOK_REQUEST_REJECTED",
        message: "TikTok từ chối yêu cầu. Vui lòng kiểm tra tài khoản và nội dung.",
      });
    }
    throw error;
  }

  disclosureFor(video: TikTokVideo) {
    return mapCommercialDisclosure(video.commercialDisclosure);
  }
}
