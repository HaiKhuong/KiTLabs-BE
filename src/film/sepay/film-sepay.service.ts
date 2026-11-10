import * as crypto from "crypto";
import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";
import {
  DonationStatus,
  FilmDonation,
  FilmItem,
  FilmMission,
  FilmSepayTransaction,
  FilmSetting,
  FilmUser,
  FilmUserExpHistory,
  FilmUserInventory,
  FilmUserMissionProgress,
  ItemType,
  PaymentMethod,
  SepayTransactionStatus,
  UserMissionStatus,
} from "../entities/film.entities";
import { FilmChatGateway } from "../film-chat.gateway";
import { filmRankFor, filmTitleFor, resolveCultivationRanks } from "../shared/film-rank.util";
import { SepayWebhookDto } from "./film-sepay.dto";

export interface SepayWebhookAuthContext {
  signature?: string;
  timestamp?: string;
  rawBody?: string;
  authHeader?: string;
  xApiKey?: string;
}

export function extractDonationUserCode(payload: {
  code?: string | null;
  content?: string | null;
  description?: string | null;
}): string | null {
  const sources = [payload.code, payload.content, payload.description].filter(Boolean) as string[];

  for (const text of sources) {
    // 1. Look for explicit prefix UH / DONATE / UNGHO followed by alphanumeric
    const prefixMatch = text.match(/(?:UH|DONATE|UNGHO)[\s_-]*([0-9a-zA-Z]{6,36})/i);
    if (prefixMatch && prefixMatch[1]) {
      return prefixMatch[1].trim();
    }
    // 2. Look for standalone 8-character hex string
    const hex8Match = text.match(/\b([0-9a-fA-F]{8})\b/);
    if (hex8Match && hex8Match[1]) {
      return hex8Match[1].trim();
    }
  }

  return null;
}

@Injectable()
export class FilmSepayService {
  private readonly logger = new Logger(FilmSepayService.name);

  constructor(
    @InjectDataSource("film") private readonly dataSource: DataSource,
    private readonly chatGateway: FilmChatGateway,
  ) {}

  /**
   * Process incoming SePay transaction webhook
   */
  async processWebhook(
    payload: SepayWebhookDto,
    authContext?: SepayWebhookAuthContext | string,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(
      `Received SePay webhook: id=${payload.id}, amount=${payload.transferAmount}, type=${payload.transferType}, content="${payload.content}"`,
    );

    // 1. Authenticate webhook request (HMAC-SHA256 signature / API key fallback)
    await this.verifyAuthentication(authContext);

    // 2. Filter transaction: only process incoming money with amount > 0
    if (payload.transferType !== "in" || Number(payload.transferAmount) <= 0) {
      this.logger.log(`Ignoring SePay transaction id=${payload.id}: not an incoming transfer or amount <= 0`);
      return { success: true, message: "Non-incoming transfer ignored" };
    }

    // 3. Idempotency check: prevent duplicate processing if SePay retries
    const existing = await this.dataSource.getRepository(FilmSepayTransaction).findOne({
      where: { sepayId: String(payload.id) },
    });
    if (existing) {
      this.logger.log(`SePay transaction id=${payload.id} already processed at ${existing.createdAt}`);
      return { success: true, message: "Transaction already processed" };
    }

    // 4. Extract user code from memo / content
    const userCode = extractDonationUserCode(payload);
    this.logger.log(`Extracted user code from SePay memo: "${userCode}"`);

    // 5. Read bank configuration to get EXP rate (default 3 EXP / 1.000 VND)
    const expRatePer1k = await this.getExpRatePer1k();
    const transferAmount = Number(payload.transferAmount);
    const rewardExp = Math.max(0, Math.floor((transferAmount / 1000) * expRatePer1k));

    // 6. Execute database transaction
    let matchedUserId: string | null = null;
    let newTotalExpStr: string | null = null;
    let newSectRankStr: string | null = null;

    await this.dataSource.transaction(async (manager: EntityManager) => {
      let user: FilmUser | null = null;
      if (userCode) {
        user = await this.findUserByCode(manager, userCode);
      }

      if (user) {
        matchedUserId = user.id;
        this.logger.log(`Matched user: ${user.name} (${user.id}) for SePay transaction id=${payload.id}`);

        // Update user stats
        const currentExp = BigInt(user.exp || 0);
        const newExpBig = currentExp + BigInt(rewardExp);
        const newExp = newExpBig.toString();
        const currentDonated = BigInt(user.totalDonatedVnd || 0);
        const newDonated = (currentDonated + BigInt(transferAmount)).toString();

        const ranks = await resolveCultivationRanks(manager);
        const newRank = filmRankFor(Number(newExp), ranks);
        const newTitle = filmTitleFor(Number(newExp), ranks);

        user.exp = newExp;
        user.totalDonatedVnd = newDonated;
        user.sectRank = newRank;
        user.currentTitle = newTitle;
        await manager.save(user);

        newTotalExpStr = newExp;
        newSectRankStr = newRank;

        // Auto unlock / equip new title if cultivation rank updated
        await this.ensureTitleEquipped(manager, user.id, newTitle);

        // Update mission progress for DONATE_BANK
        await this.updateDonateMissionProgress(manager, user.id, transferAmount, rewardExp);

        // Record to EXP history
        const expHistory = manager.create(FilmUserExpHistory, {
          userId: user.id,
          missionCode: "DONATE_BANK",
          amount: rewardExp,
          balanceAfter: newExp,
          title: "Donate ủng hộ ngân hàng",
          description: `Ủng hộ ${transferAmount.toLocaleString("vi-VN")}đ qua SePay (+${rewardExp} EXP)`,
          rawData: {
            sepayId: payload.id,
            gateway: payload.gateway,
            accountNumber: payload.accountNumber,
            transferAmount,
            transactionDate: payload.transactionDate,
            content: payload.content,
            referenceCode: payload.referenceCode,
          },
        });
        await manager.save(expHistory);

        // Record to donations table
        const donation = manager.create(FilmDonation, {
          userId: user.id,
          movieId: null,
          amountVnd: transferAmount.toString(),
          spiritStonesConverted: "0",
          paymentMethod: PaymentMethod.BANK_TRANSFER,
          transactionCode: `sepay_${payload.id}`,
          status: DonationStatus.SUCCESS,
          message: payload.content,
          rewardAppliedAt: new Date(),
        });
        await manager.save(donation);

        // Save SePay transaction record as SUCCESS
        const txRecord = manager.create(FilmSepayTransaction, {
          sepayId: String(payload.id),
          gateway: payload.gateway,
          transactionDate: payload.transactionDate || null,
          accountNumber: payload.accountNumber,
          subAccount: payload.subAccount || null,
          code: payload.code || null,
          content: payload.content,
          transferType: payload.transferType,
          description: payload.description || null,
          transferAmount: transferAmount.toString(),
          accumulated: String(payload.accumulated || 0),
          referenceCode: payload.referenceCode || null,
          userId: user.id,
          rewardExp,
          status: SepayTransactionStatus.SUCCESS,
          rawPayload: payload as unknown as Record<string, any>,
        });
        await manager.save(txRecord);
      } else {
        this.logger.warn(
          `No user matched for SePay transaction id=${payload.id}, memo="${payload.content}", code="${userCode}"`,
        );

        // Save as UNMATCHED transaction for admin inspection
        const txRecord = manager.create(FilmSepayTransaction, {
          sepayId: String(payload.id),
          gateway: payload.gateway,
          transactionDate: payload.transactionDate || null,
          accountNumber: payload.accountNumber,
          subAccount: payload.subAccount || null,
          code: payload.code || null,
          content: payload.content,
          transferType: payload.transferType,
          description: payload.description || null,
          transferAmount: transferAmount.toString(),
          accumulated: String(payload.accumulated || 0),
          referenceCode: payload.referenceCode || null,
          userId: null,
          rewardExp: 0,
          status: SepayTransactionStatus.UNMATCHED,
          rawPayload: payload as unknown as Record<string, any>,
        });
        await manager.save(txRecord);
      }
    });

    // 7. Send real-time notification to user via WebSocket if connected
    if (matchedUserId && newTotalExpStr && newSectRankStr) {
      try {
        await this.chatGateway.notifyMissionReward(matchedUserId, {
          missionCode: "DONATE_BANK",
          claimedExp: rewardExp,
          newTotalExp: newTotalExpStr,
          newSectRank: newSectRankStr,
          message: `Đa tạ đạo hữu đã cống hiến ${transferAmount.toLocaleString("vi-VN")}đ! Bạn nhận được +${rewardExp} EXP!`,
          claimedAt: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.warn(`Failed to dispatch socket reward to user ${matchedUserId}: ${(err as Error).message}`);
      }
    }

    return {
      success: true,
      message: matchedUserId ? "Donation processed and EXP awarded" : "Donation recorded as unmatched",
    };
  }

  /**
   * Verify HMAC-SHA256 signature (X-SePay-Signature) or Authorization header against configured SePay Secret Key
   */
  private async verifyAuthentication(authContext?: SepayWebhookAuthContext | string): Promise<void> {
    const ctx: SepayWebhookAuthContext =
      typeof authContext === "string" ? { authHeader: authContext } : authContext || {};

    const setting = await this.dataSource.getRepository(FilmSetting).findOne({
      where: { key: "BANK_ACCOUNT" },
    });
    const configValue = (setting?.value || {}) as Record<string, any>;
    const secretKey: string =
      (configValue.sepaySecretKey?.trim() as string) ||
      (configValue.sepayApiKey?.trim() as string) ||
      (process.env.SEPAY_SECRET_KEY?.trim() as string) ||
      (process.env.SEPAY_WEBHOOK_SECRET?.trim() as string) ||
      (process.env.SEPAY_API_KEY?.trim() as string) ||
      "";

    // If no secret key is configured on server/admin, allow request
    if (!secretKey) {
      return;
    }

    // 1. Primary: HMAC-SHA256 signature verification (X-SePay-Signature & X-SePay-Timestamp)
    if (ctx.signature) {
      // Replay attack protection: ensure timestamp is within 10 minutes (600s)
      if (ctx.timestamp) {
        const ts = Number(ctx.timestamp);
        const now = Math.floor(Date.now() / 1000);
        if (!isNaN(ts) && Math.abs(now - ts) > 600) {
          this.logger.warn(`SePay webhook timestamp expired: timestamp=${ts}, now=${now}`);
          throw new UnauthorizedException("SePay webhook timestamp expired (replay protection)");
        }
      }

      const payloadToSign = `${ctx.timestamp || ""}.${ctx.rawBody || ""}`;
      const hmacHex = crypto.createHmac("sha256", secretKey).update(payloadToSign).digest("hex");
      const expectedSignature = `sha256=${hmacHex}`;

      const receivedSig = ctx.signature.trim();
      const isMatch = receivedSig === expectedSignature || receivedSig === hmacHex;

      if (!isMatch) {
        this.logger.warn(
          `Invalid SePay HMAC-SHA256 signature. Expected="${expectedSignature}", Received="${receivedSig}"`,
        );
        throw new UnauthorizedException("Invalid SePay webhook signature (HMAC-SHA256 mismatch)");
      }

      this.logger.log("SePay webhook verified successfully via HMAC-SHA256 signature.");
      return;
    }

    // 2. Fallback: Legacy API Key verification (Authorization: Apikey ...)
    let receivedKey = "";
    if (ctx.authHeader) {
      const parts = ctx.authHeader.trim().split(" ");
      receivedKey = parts.length >= 2 ? parts[1].trim() : parts[0].trim();
    } else if (ctx.xApiKey) {
      receivedKey = ctx.xApiKey.trim();
    }

    if (receivedKey && receivedKey === secretKey) {
      this.logger.log("SePay webhook authenticated via API Key token fallback.");
      return;
    }

    this.logger.warn("Unauthorized SePay webhook attempt: missing valid X-SePay-Signature or API Key");
    throw new UnauthorizedException("Invalid or missing SePay HMAC signature / API Key");
  }

  /**
   * Get configured EXP reward rate per 1.000 VND from Mission settings (DONATE_BANK)
   */
  private async getExpRatePer1k(): Promise<number> {
    try {
      const mission = await this.dataSource.getRepository(FilmMission).findOne({
        where: { code: "DONATE_BANK" },
      });
      if (mission && typeof mission.rewardExp === "number" && mission.rewardExp > 0) {
        return mission.rewardExp;
      }
    } catch (err) {
      this.logger.warn(`Failed to fetch DONATE_BANK mission rewardExp: ${(err as Error).message}`);
    }
    return 3; // Default fallback 3 EXP per 1.000 VND
  }

  /**
   * Look up user by code (UUID prefix or exact username/email)
   */
  private async findUserByCode(manager: EntityManager, code: string): Promise<FilmUser | null> {
    if (!code) return null;
    const cleanCode = code.replace(/-/g, "").toLowerCase();

    // 1. Match UUID hex prefix (at least 6 chars)
    if (cleanCode.length >= 6) {
      const user = await manager
        .getRepository(FilmUser)
        .createQueryBuilder("user")
        .where("REPLACE(user.id::text, '-', '') ILIKE :prefix", { prefix: `${cleanCode}%` })
        .getOne();
      if (user) return user;
    }

    // 2. Exact UUID format
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code)) {
      const user = await manager.getRepository(FilmUser).findOne({ where: { id: code } });
      if (user) return user;
    }

    // 3. Fallback to username or email
    return manager.getRepository(FilmUser).findOne({
      where: [{ username: code.toLowerCase() }, { email: code.toLowerCase() }],
    });
  }

  /**
   * Ensure user's new cultivation title is unlocked and equipped in inventory
   */
  private async ensureTitleEquipped(manager: EntityManager, userId: string, titleSlug: string): Promise<void> {
    try {
      const titleItem = await manager
        .getRepository(FilmItem)
        .createQueryBuilder("item")
        .where("item.type = :type", { type: ItemType.TITLE })
        .andWhere("item.assetConfig ->> 'slug' IN (:...slugs)", {
          slugs: [titleSlug, titleSlug.replace(/_ky$/, "_so_ky")],
        })
        .getOne();

      if (!titleItem) return;

      await manager.query(
        `UPDATE user_inventories inventory
         SET is_equipped = false, updated_at = now()
         FROM items item
         WHERE inventory.item_id = item.id
           AND inventory.user_id = $1
           AND inventory.is_equipped = true
           AND item.type = 'TITLE'
           AND inventory.item_id <> $2`,
        [userId, titleItem.id],
      );

      const invRepo = manager.getRepository(FilmUserInventory);
      let titleInv = await invRepo.findOne({
        where: { userId, itemId: titleItem.id },
      });
      if (!titleInv) {
        titleInv = invRepo.create({
          userId,
          itemId: titleItem.id,
          isEquipped: true,
          expiresAt: null,
        });
      } else {
        titleInv.isEquipped = true;
      }
      await invRepo.save(titleInv);
    } catch (err) {
      this.logger.warn(`Failed to auto-equip title ${titleSlug} for user ${userId}: ${(err as Error).message}`);
    }
  }

  /**
   * Update mission progress for DONATE_BANK
   */
  private async updateDonateMissionProgress(
    manager: EntityManager,
    userId: string,
    transferAmount: number,
    rewardExp: number,
  ): Promise<void> {
    try {
      const progressRepo = manager.getRepository(FilmUserMissionProgress);
      let progress = await progressRepo.findOne({
        where: { userId, missionCode: "DONATE_BANK", dateKey: "ALL" },
      });

      if (!progress) {
        progress = progressRepo.create({
          userId,
          missionCode: "DONATE_BANK",
          dateKey: "ALL",
          currentCount: 0,
          claimedExp: 0,
          status: UserMissionStatus.IN_PROGRESS,
          metadata: { lastDonationAt: new Date().toISOString() },
        });
      }

      progress.currentCount += Math.floor(transferAmount / 1000);
      progress.claimedExp += rewardExp;
      progress.metadata = {
        ...(progress.metadata || {}),
        lastDonationAt: new Date().toISOString(),
      };
      await progressRepo.save(progress);
    } catch (err) {
      this.logger.warn(`Failed to update DONATE_BANK mission progress for user ${userId}: ${(err as Error).message}`);
    }
  }
}
