import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import axios from "axios";
import { Repository } from "typeorm";
import { decryptSecret, encryptSecret } from "../../common/config/settings-crypto";
import { PlatformOAuthStateService } from "../common/platform-oauth-state.service";
import { validateApiServerUrl } from "../common/platform.util";
import { PlatformAccount, PlatformAccountStatus } from "../entities/platform-account.entity";
import { PlatformFacebookPage, PlatformFacebookPageStatus } from "../entities/platform-facebook-page.entity";
import { FacebookGraphClient } from "./facebook-graph.client";

export const FACEBOOK_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "publish_video",
];

@Injectable()
export class PlatformFacebookService {
  private readonly logger = new Logger(PlatformFacebookService.name);

  constructor(
    @InjectRepository(PlatformAccount)
    private readonly accountRepo: Repository<PlatformAccount>,
    @InjectRepository(PlatformFacebookPage)
    private readonly pageRepo: Repository<PlatformFacebookPage>,
    private readonly graph: FacebookGraphClient,
    private readonly oauthStates: PlatformOAuthStateService,
  ) {}

  async connect(userId: string): Promise<{ authorizationUrl: string }> {
    const state = await this.oauthStates.create("facebook", userId);
    return { authorizationUrl: await this.graph.authorizationUrl(state) };
  }

  async completeOAuth(input: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<{ userId: string; ticket: string }> {
    if (input.error) throw new BadRequestException("Facebook từ chối đăng nhập");
    if (!input.state || !input.code) throw new BadRequestException("OAuth callback không hợp lệ");
    const userId = await this.oauthStates.consume("facebook", input.state);
    if (!userId) throw new BadRequestException("Phiên đăng nhập Facebook đã hết hạn");

    const shortLived = await this.graph.exchangeCode(input.code);
    const longLived = await this.graph.exchangeLongLived(shortLived.accessToken);
    const debug = await this.graph.debugToken(longLived.accessToken);
    const profile = await this.graph.getProfile(longLived.accessToken);
    const missing = FACEBOOK_REQUIRED_SCOPES.filter((scope) => !debug.scopes.includes(scope));

    let account = await this.accountRepo.findOne({
      where: { userId, provider: "facebook" },
    });
    if (!account) {
      account = this.accountRepo.create({
        userId,
        provider: "facebook",
        accountId: profile.id,
      });
    }

    account.accountId = profile.id;
    account.displayName = profile.name;
    account.avatarUrl = profile.pictureUrl ?? null;
    account.accessTokenEncrypted = encryptSecret(longLived.accessToken);
    account.tokenExpiresAt = longLived.expiresIn
      ? new Date(Date.now() + longLived.expiresIn * 1000)
      : debug.expiresAt ?? null;
    account.scopes = debug.scopes;
    account.status = missing.length
      ? PlatformAccountStatus.MISSING_PERMISSION
      : PlatformAccountStatus.CONNECTED;
    account.lastCheckedAt = new Date();
    account.lastCheckMessage = missing.length ? `Thiếu quyền: ${missing.join(", ")}` : null;

    account = await this.accountRepo.save(account);
    await this.syncPages(account, longLived.accessToken);

    const pages = await this.pageRepo.find({ where: { accountId: account.id } });
    const ticket = await this.oauthStates.createHandoff("facebook", {
      provider: "facebook",
      account: {
        accountId: account.accountId,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        accessToken: longLived.accessToken,
        tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
        scopes: account.scopes,
        status: account.status,
      },
      pages: pages.map((page) => ({
        pageId: page.pageId,
        name: page.name,
        pictureUrl: page.pictureUrl,
        pageAccessToken: page.pageAccessTokenEncrypted
          ? decryptSecret(page.pageAccessTokenEncrypted)
          : null,
        tasks: page.tasks,
        canPublish: page.canPublish,
        canComment: page.canComment,
        status: page.status,
      })),
    });

    return { userId, ticket };
  }

  async redeemHandoff(ticket: string) {
    const payload = await this.oauthStates.consumeHandoff("facebook", ticket);
    if (!payload || payload.provider !== "facebook") {
      throw new BadRequestException("OAuth handoff is invalid or expired");
    }
    return payload;
  }

  async importHandoff(userId: string, apiServerUrl: string, ticket: string) {
    const base = validateApiServerUrl(apiServerUrl);
    const response = await axios.post(
      `${base}/api/platform/facebook/handoff/redeem`,
      { ticket },
      { timeout: 15_000 },
    );
    const payload = (response.data?.data ?? response.data) as any;
    if (payload?.provider !== "facebook" || !payload.account?.accessToken) {
      throw new BadRequestException("Invalid Facebook handoff payload");
    }

    let account = await this.accountRepo.findOne({
      where: { userId, provider: "facebook" },
    });
    if (!account) {
      account = this.accountRepo.create({
        userId,
        provider: "facebook",
        accountId: String(payload.account.accountId),
      });
    }

    Object.assign(account, {
      accountId: String(payload.account.accountId),
      displayName: payload.account.displayName ?? null,
      avatarUrl: payload.account.avatarUrl ?? null,
      accessTokenEncrypted: encryptSecret(String(payload.account.accessToken)),
      tokenExpiresAt: payload.account.tokenExpiresAt
        ? new Date(payload.account.tokenExpiresAt)
        : null,
      scopes: Array.isArray(payload.account.scopes) ? payload.account.scopes.map(String) : [],
      status: payload.account.status ?? PlatformAccountStatus.CONNECTED,
      lastCheckedAt: new Date(),
      lastCheckMessage: null,
    });
    account = await this.accountRepo.save(account);

    for (const item of Array.isArray(payload.pages) ? payload.pages : []) {
      let page = await this.pageRepo.findOne({
        where: { accountId: account.id, pageId: String(item.pageId) },
      });
      if (!page) {
        page = this.pageRepo.create({
          accountId: account.id,
          pageId: String(item.pageId),
          name: String(item.name ?? ""),
        });
      }
      Object.assign(page, {
        name: String(item.name ?? ""),
        pictureUrl: item.pictureUrl ?? null,
        pageAccessTokenEncrypted: item.pageAccessToken
          ? encryptSecret(String(item.pageAccessToken))
          : null,
        tasks: Array.isArray(item.tasks) ? item.tasks.map(String) : [],
        canPublish: Boolean(item.canPublish),
        canComment: Boolean(item.canComment),
        status: item.status ?? PlatformFacebookPageStatus.ACTIVE,
        lastCheckedAt: new Date(),
      });
      await this.pageRepo.save(page);
    }

    return this.connection(userId);
  }

  async disconnect(userId: string): Promise<{ disconnected: true }> {
    const account = await this.accountRepo.findOne({
      where: { userId, provider: "facebook" },
    });
    if (!account) return { disconnected: true };

    account.status = PlatformAccountStatus.REVOKED;
    account.accessTokenEncrypted = null;
    account.lastCheckMessage = "Đã ngắt kết nối";
    account.lastCheckedAt = new Date();
    await this.accountRepo.save(account);

    const pages = await this.pageRepo.find({ where: { accountId: account.id } });
    for (const page of pages) {
      page.status = PlatformFacebookPageStatus.LOST_ACCESS;
      page.canPublish = false;
      page.canComment = false;
      page.pageAccessTokenEncrypted = null;
      await this.pageRepo.save(page);
    }

    return { disconnected: true };
  }

  async connection(userId: string) {
    const account = await this.accountRepo.findOne({
      where: { userId, provider: "facebook" },
    });
    if (!account) {
      return {
        connected: false,
        account: null,
        requiredScopes: FACEBOOK_REQUIRED_SCOPES,
        missingScopes: [...FACEBOOK_REQUIRED_SCOPES],
        pages: [],
      };
    }
    const pages = await this.pageRepo.find({
      where: { accountId: account.id },
      order: { name: "ASC" },
    });
    const missingScopes = FACEBOOK_REQUIRED_SCOPES.filter(
      (scope) => !account.scopes.includes(scope),
    );
    return {
      connected: account.status === PlatformAccountStatus.CONNECTED && missingScopes.length === 0,
      account: {
        id: account.id,
        fbUserId: account.accountId,
        name: account.displayName,
        pictureUrl: account.avatarUrl,
        status: account.status,
        scopes: account.scopes,
        tokenExpiresAt: account.tokenExpiresAt,
        lastCheckedAt: account.lastCheckedAt,
        lastCheckMessage: account.lastCheckMessage,
      },
      requiredScopes: FACEBOOK_REQUIRED_SCOPES,
      missingScopes,
      pages: pages.map((page) => ({
        id: page.id,
        pageId: page.pageId,
        name: page.name,
        pictureUrl: page.pictureUrl,
        tasks: page.tasks,
        canPublish: page.canPublish,
        canComment: page.canComment,
        status: page.status,
        lastCheckedAt: page.lastCheckedAt,
      })),
    };
  }

  async checkConnection(userId: string) {
    const account = await this.accountRepo.findOne({
      where: { userId, provider: "facebook" },
    });
    if (!account) throw new NotFoundException("Chưa kết nối Facebook");

    if (!account.accessTokenEncrypted) {
      account.status = PlatformAccountStatus.REVOKED;
      account.lastCheckMessage = "Chưa có token. Hãy kết nối lại.";
      account.lastCheckedAt = new Date();
      await this.accountRepo.save(account);
      return this.connection(userId);
    }

    try {
      let token = decryptSecret(account.accessTokenEncrypted);
      if (
        account.tokenExpiresAt &&
        account.tokenExpiresAt.getTime() - Date.now() < 7 * 86_400_000
      ) {
        const renewed = await this.graph.exchangeLongLived(token);
        token = renewed.accessToken;
        account.accessTokenEncrypted = encryptSecret(token);
        account.tokenExpiresAt = renewed.expiresIn
          ? new Date(Date.now() + renewed.expiresIn * 1000)
          : account.tokenExpiresAt;
      }
      const debug = await this.graph.debugToken(token);
      const missing = FACEBOOK_REQUIRED_SCOPES.filter((scope) => !debug.scopes.includes(scope));
      account.scopes = debug.scopes;
      account.tokenExpiresAt = debug.expiresAt ?? account.tokenExpiresAt;
      account.lastCheckedAt = new Date();

      if (!debug.isValid) {
        account.status = PlatformAccountStatus.REVOKED;
        account.lastCheckMessage = "Token không còn hiệu lực";
      } else if (missing.length) {
        account.status = PlatformAccountStatus.MISSING_PERMISSION;
        account.lastCheckMessage = `Thiếu quyền: ${missing.join(", ")}`;
      } else if (debug.expiresAt && debug.expiresAt.getTime() <= Date.now()) {
        account.status = PlatformAccountStatus.EXPIRED;
        account.lastCheckMessage = "Token đã hết hạn";
      } else {
        account.status = PlatformAccountStatus.CONNECTED;
        account.lastCheckMessage = null;
        const profile = await this.graph.getProfile(token);
        account.displayName = profile.name;
        account.avatarUrl = profile.pictureUrl ?? account.avatarUrl;
      }
      await this.accountRepo.save(account);

      if (account.status === PlatformAccountStatus.CONNECTED) {
        await this.syncPages(account, token);
      }
    } catch (err) {
      this.logger.warn(`Check FB connection error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.connection(userId);
  }

  private async syncPages(account: PlatformAccount, userToken: string): Promise<void> {
    const grants = await this.graph.listPages(userToken);
    const existing = await this.pageRepo.find({ where: { accountId: account.id } });
    const seen = new Set<string>();

    for (const grant of grants) {
      seen.add(grant.id);
      const tasks = grant.tasks ?? [];
      const canPublish = tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE");
      let row = existing.find((p) => p.pageId === grant.id);
      if (!row) {
        row = this.pageRepo.create({
          accountId: account.id,
          pageId: grant.id,
          name: grant.name,
        });
      }
      row.name = grant.name;
      row.pictureUrl = grant.pictureUrl ?? null;
      row.pageAccessTokenEncrypted = encryptSecret(grant.accessToken);
      row.tasks = tasks;
      row.canPublish = canPublish;
      row.canComment = canPublish || tasks.includes("MODERATE");
      row.status = canPublish ? PlatformFacebookPageStatus.ACTIVE : PlatformFacebookPageStatus.LOST_ACCESS;
      row.lastCheckedAt = new Date();
      await this.pageRepo.save(row);
    }

    for (const row of existing) {
      if (seen.has(row.pageId)) continue;
      row.status = PlatformFacebookPageStatus.LOST_ACCESS;
      row.canPublish = false;
      row.canComment = false;
      row.lastCheckedAt = new Date();
      await this.pageRepo.save(row);
    }
  }

  /**
   * Helper method exported for tools to get a valid decrypted page token & verify page permissions
   */
  async getValidPageAccessToken(
    userId: string,
    pageId: string,
  ): Promise<{
    page: { id: string; pageId: string; name: string };
    token: string;
  }> {
    const account = await this.accountRepo.findOne({
      where: { userId, provider: "facebook" },
    });
    if (!account || account.status !== PlatformAccountStatus.CONNECTED || !account.accessTokenEncrypted) {
      throw new UnauthorizedException("Tài khoản Facebook chưa kết nối hoặc token đã hết hạn");
    }

    const page = await this.pageRepo.findOne({
      where: { id: pageId, accountId: account.id },
    });
    if (!page || page.status !== PlatformFacebookPageStatus.ACTIVE || !page.canPublish || !page.pageAccessTokenEncrypted) {
      throw new UnauthorizedException("Page Facebook không có quyền đăng bài hoặc chưa sẵn sàng");
    }

    const token = decryptSecret(page.pageAccessTokenEncrypted);
    return {
      page: {
        id: page.id,
        pageId: page.pageId,
        name: page.name,
      },
      token,
    };
  }

  async getPageById(userId: string, pageId: string): Promise<PlatformFacebookPage> {
    const account = await this.accountRepo.findOne({
      where: { userId, provider: "facebook" },
    });
    if (!account) throw new NotFoundException("Chưa kết nối Facebook");
    const page = await this.pageRepo.findOne({
      where: { id: pageId, accountId: account.id },
    });
    if (!page) throw new NotFoundException("Không tìm thấy Page");
    return page;
  }
}

