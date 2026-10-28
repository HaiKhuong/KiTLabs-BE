import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import axios from "axios";
import { Repository } from "typeorm";
import { decryptSecret, encryptSecret } from "../../common/config/settings-crypto";
import { PlatformOAuthStateService } from "../common/platform-oauth-state.service";
import { validateApiServerUrl } from "../common/platform.util";
import { PlatformAccount, PlatformAccountStatus } from "../entities/platform-account.entity";
import { TikTokApiClient } from "./tiktok-api.client";

@Injectable()
export class PlatformTikTokService {
  private readonly logger = new Logger(PlatformTikTokService.name);

  constructor(
    @InjectRepository(PlatformAccount)
    private readonly accountRepo: Repository<PlatformAccount>,
    private readonly client: TikTokApiClient,
    private readonly oauthStates: PlatformOAuthStateService,
  ) {}

  async connect(userId: string): Promise<{ authorizationUrl: string }> {
    const state = await this.oauthStates.create("tiktok", userId);
    return { authorizationUrl: await this.client.authorizationUrl(state) };
  }

  async completeOAuth(input: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<{ userId: string; account: any; ticket: string }> {
    if (input.error) throw new BadRequestException("TikTok từ chối uỷ quyền");
    if (!input.state || !input.code) throw new BadRequestException("OAuth callback không hợp lệ");
    const userId = await this.oauthStates.consume("tiktok", input.state);
    if (!userId) throw new BadRequestException("OAuth state đã hết hạn");

    const tokens = await this.client.exchangeCode(input.code);
    const granted = new Set(String(tokens.scope ?? "").split(",").filter(Boolean));
    for (const required of ["user.info.basic", "video.publish", "video.list"]) {
      if (!granted.has(required)) {
        throw new BadRequestException("Tài khoản TikTok chưa cấp đủ quyền bắt buộc");
      }
    }

    const profile = await this.client.getUser(tokens.access_token);
    if (!profile.openId || profile.openId !== tokens.open_id) {
      throw new BadRequestException("Không thể xác thực danh tính TikTok");
    }

    try {
      const creator = await this.client.creatorInfo(tokens.access_token);
      profile.username = creator.creator_username || profile.username;
      profile.displayName = creator.creator_nickname || profile.displayName;
      profile.avatarUrl = creator.creator_avatar_url || profile.avatarUrl;
    } catch (err) {
      this.logger.warn(`Could not fetch creatorInfo: ${err instanceof Error ? err.message : String(err)}`);
    }

    const existing = await this.accountRepo.findOne({
      where: { userId, provider: "tiktok", accountId: profile.openId },
    });
    if (!existing && (await this.accountRepo.count({ where: { userId, provider: "tiktok" } })) >= 2) {
      throw new ConflictException("Chỉ có thể kết nối tối đa 2 tài khoản TikTok.");
    }

    const account =
      existing ??
      this.accountRepo.create({
        userId,
        provider: "tiktok",
        accountId: profile.openId,
        isActive: false,
      });

    Object.assign(account, {
      unionId: profile.unionId ?? null,
      username: profile.username ?? null,
      displayName: profile.displayName ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      accessTokenEncrypted: encryptSecret(tokens.access_token),
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
      tokenExpiresAt: new Date(Date.now() + Number(tokens.expires_in) * 1000),
      refreshExpiresAt: new Date(Date.now() + Number(tokens.refresh_expires_in) * 1000),
      scopes: [...granted],
      status: PlatformAccountStatus.CONNECTED,
    });

    if (!(await this.accountRepo.exists({ where: { userId, provider: "tiktok", isActive: true } }))) {
      account.isActive = true;
    }
    const saved = await this.accountRepo.save(account);

    const ticket = await this.oauthStates.createHandoff("tiktok", {
      provider: "tiktok",
      account: {
        openId: saved.accountId,
        unionId: saved.unionId,
        username: saved.username,
        displayName: saved.displayName,
        avatarUrl: saved.avatarUrl,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: saved.tokenExpiresAt?.toISOString(),
        refreshTokenExpiresAt: saved.refreshExpiresAt?.toISOString(),
        scopes: saved.scopes,
        status: saved.status,
        isActive: saved.isActive,
      },
    });

    return { userId, account: this.mapAccount(saved), ticket };
  }

  async redeemHandoff(ticket: string) {
    const payload = await this.oauthStates.consumeHandoff("tiktok", ticket);
    if (!payload || payload.provider !== "tiktok") {
      throw new BadRequestException("OAuth handoff is invalid or expired");
    }
    return payload;
  }

  async importHandoff(userId: string, apiServerUrl: string, ticket: string) {
    const base = validateApiServerUrl(apiServerUrl);
    const response = await axios.post(
      `${base}/api/platform/tiktok/handoff/redeem`,
      { ticket },
      { timeout: 15_000 },
    );
    const payload = (response.data?.data ?? response.data) as any;
    const item = payload?.account;
    if (payload?.provider !== "tiktok" || !item?.openId || !item?.accessToken || !item?.refreshToken) {
      throw new BadRequestException("Invalid TikTok handoff payload");
    }

    let account = await this.accountRepo.findOne({
      where: { userId, provider: "tiktok", accountId: String(item.openId) },
    });
    if (!account && (await this.accountRepo.count({ where: { userId, provider: "tiktok" } })) >= 2) {
      throw new ConflictException("Chỉ có thể kết nối tối đa 2 tài khoản TikTok.");
    }
    account ??= this.accountRepo.create({
      userId,
      provider: "tiktok",
      accountId: String(item.openId),
      isActive: false,
    });

    Object.assign(account, {
      unionId: item.unionId ? String(item.unionId) : null,
      username: item.username ? String(item.username) : null,
      displayName: item.displayName ? String(item.displayName) : null,
      avatarUrl: item.avatarUrl ? String(item.avatarUrl) : null,
      accessTokenEncrypted: encryptSecret(String(item.accessToken)),
      refreshTokenEncrypted: encryptSecret(String(item.refreshToken)),
      tokenExpiresAt: new Date(String(item.accessTokenExpiresAt)),
      refreshExpiresAt: new Date(String(item.refreshTokenExpiresAt)),
      scopes: Array.isArray(item.scopes) ? item.scopes.map(String) : [],
      status: item.status ?? PlatformAccountStatus.CONNECTED,
    });

    if (!(await this.accountRepo.exists({ where: { userId, provider: "tiktok", isActive: true } }))) {
      account.isActive = true;
    }
    const saved = await this.accountRepo.save(account);
    return this.mapAccount(saved);
  }

  async listAccounts(userId: string) {
    const rows = await this.accountRepo.find({
      where: { userId, provider: "tiktok" },
      order: { createdAt: "ASC" },
    });
    return rows.map((r) => this.mapAccount(r));
  }

  async refreshAccount(userId: string, accountId: string) {
    const account = await this.ownedAccount(userId, accountId);
    await this.rotateTokens(account);
    try {
      const creator = await this.client.creatorInfo(decryptSecret(account.accessTokenEncrypted!));
      account.username = creator.creator_username || account.username;
      account.displayName = creator.creator_nickname || account.displayName;
      account.avatarUrl = creator.creator_avatar_url || account.avatarUrl;
      await this.accountRepo.save(account);
    } catch (err) {
      this.logger.warn(`Refresh TikTok account creatorInfo failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.mapAccount(account);
  }

  async disconnect(userId: string, accountId: string): Promise<{ disconnected: true }> {
    const account = await this.ownedAccount(userId, accountId);
    if (account.accessTokenEncrypted) {
      try {
        await this.client.revoke(decryptSecret(account.accessTokenEncrypted));
      } catch (err) {
        this.logger.warn(`TikTok revoke token error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.accountRepo.remove(account);

    if (account.isActive) {
      const next = await this.accountRepo.findOne({
        where: { userId, provider: "tiktok" },
        order: { createdAt: "ASC" },
      });
      if (next) {
        next.isActive = true;
        await this.accountRepo.save(next);
      }
    }
    return { disconnected: true };
  }

  async ownedAccount(userId: string, id: string): Promise<PlatformAccount> {
    const row = await this.accountRepo.findOne({
      where: { id, userId, provider: "tiktok" },
    });
    if (!row) throw new NotFoundException("TikTok account not found");
    return row;
  }

  async getValidAccessToken(userId: string, accountId: string): Promise<string> {
    const account = await this.ownedAccount(userId, accountId);
    if (!account.accessTokenEncrypted) {
      throw new ForbiddenException("TikTok account does not have access token");
    }
    if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() > Date.now() + 60_000) {
      return decryptSecret(account.accessTokenEncrypted);
    }
    await this.rotateTokens(account);
    return decryptSecret(account.accessTokenEncrypted);
  }

  private async rotateTokens(account: PlatformAccount): Promise<void> {
    if (!account.refreshTokenEncrypted || (account.refreshExpiresAt && account.refreshExpiresAt.getTime() <= Date.now())) {
      account.status = PlatformAccountStatus.EXPIRED;
      await this.accountRepo.save(account);
      throw new ForbiddenException("TikTok authorization expired. Please reconnect.");
    }
    const token = await this.client.refreshToken(decryptSecret(account.refreshTokenEncrypted));
    account.accessTokenEncrypted = encryptSecret(token.access_token);
    account.refreshTokenEncrypted = encryptSecret(token.refresh_token);
    account.tokenExpiresAt = new Date(Date.now() + Number(token.expires_in) * 1000);
    account.refreshExpiresAt = new Date(Date.now() + Number(token.refresh_expires_in) * 1000);
    account.scopes = String(token.scope ?? "").split(",").filter(Boolean);
    account.status = PlatformAccountStatus.CONNECTED;
    await this.accountRepo.save(account);
  }

  private mapAccount(row: PlatformAccount) {
    return {
      id: row.id,
      openId: row.accountId,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      scopes: row.scopes,
      status: row.status,
      isActive: row.isActive,
      accessTokenExpiresAt: row.tokenExpiresAt,
      refreshTokenExpiresAt: row.refreshExpiresAt,
      createdAt: row.createdAt,
    };
  }
}

