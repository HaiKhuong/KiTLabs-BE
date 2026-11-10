import * as crypto from "crypto";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
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
import { TelegramService } from "../../telegram/telegram.service";
import { SepayWebhookDto } from "./film-sepay.dto";

export interface SepayWebhookAuthContext {
  signature?: string;
  timestamp?: string;
  rawBody?: string;
  authHeader?: string;
  xApiKey?: string;
  isInternalRetry?: boolean;
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
    private readonly telegramService: TelegramService,
  ) {}

  /**
   * Process incoming SePay transaction webhook
   */
  async processWebhook(
    payload: SepayWebhookDto,
    authContext?: SepayWebhookAuthContext | string,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(
      `Received SePay webhook: id=${payload?.id}, amount=${payload?.transferAmount}, type=${payload?.transferType}, content="${payload?.content}"`,
    );

    if (!payload || !payload.id) {
      this.logger.error("SePay webhook payload is missing required field 'id'");
      throw new BadRequestException("Payload missing required 'id'");
    }

    const txRepo = this.dataSource.getRepository(FilmSepayTransaction);

    const isRetry = typeof authContext === "object" && Boolean(authContext?.isInternalRetry);

    // 1. Idempotency check: if transaction was already processed successfully or ignored, return immediately (unless forced retry)
    let txRecord = await txRepo.findOne({
      where: { sepayId: String(payload.id) },
    });

    if (
      txRecord &&
      !isRetry &&
      (txRecord.status === SepayTransactionStatus.SUCCESS || txRecord.status === SepayTransactionStatus.IGNORED)
    ) {
      this.logger.log(`SePay transaction id=${payload.id} already processed with status ${txRecord.status}`);
      return { success: true, message: "Transaction already processed" };
    }

    // 2. Insert into DB immediately with PENDING status so that the raw payload and record are saved
    const transferAmount = Number(payload.transferAmount || 0);
    if (!txRecord) {
      txRecord = txRepo.create({
        sepayId: String(payload.id),
        gateway: payload.gateway || "UNKNOWN",
        transactionDate: payload.transactionDate || null,
        accountNumber: payload.accountNumber || "",
        subAccount: payload.subAccount || null,
        code: payload.code || null,
        content: payload.content || "",
        transferType: payload.transferType || "in",
        description: payload.description || null,
        transferAmount: transferAmount.toString(),
        accumulated: String(payload.accumulated || 0),
        referenceCode: payload.referenceCode || null,
        userId: null,
        rewardExp: 0,
        status: SepayTransactionStatus.PENDING,
        errorMessage: null,
        rawPayload: payload as unknown as Record<string, any>,
      });
    } else {
      txRecord.status = SepayTransactionStatus.PENDING;
      txRecord.errorMessage = null;
      txRecord.rawPayload = payload as unknown as Record<string, any>;
    }
    txRecord = await txRepo.save(txRecord);

    const userCode = extractDonationUserCode(payload);

    try {
      // 3. Authenticate webhook request (HMAC-SHA256 signature / API key fallback)
      await this.verifyAuthentication(authContext);

      // 4. Filter transaction: only process incoming money with amount > 0
      if (payload.transferType !== "in" || transferAmount <= 0) {
        this.logger.log(`Ignoring SePay transaction id=${payload.id}: not an incoming transfer or amount <= 0`);
        txRecord.status = SepayTransactionStatus.IGNORED;
        txRecord.errorMessage = "Non-incoming transfer or amount <= 0";
        await txRepo.save(txRecord);
        return { success: true, message: "Non-incoming transfer ignored" };
      }

      // 5. Log extracted user code
      this.logger.log(`Extracted user code from SePay memo: "${userCode}"`);

      // 6. Read bank configuration to get EXP rate (default 3 EXP / 1.000 VND)
      const expRatePer1k = await this.getExpRatePer1k();
      const rewardExp = Math.max(0, Math.floor((transferAmount / 1000) * expRatePer1k));

      // 7. Execute database transaction
      let matchedUserId: string | null = null;
      let matchedUserName: string | null = null;
      let newTotalExpStr: string | null = null;
      let newSectRankStr: string | null = null;

      await this.dataSource.transaction(async (manager: EntityManager) => {
        let user: FilmUser | null = null;
        if (userCode) {
          user = await this.findUserByCode(manager, userCode);
        }

        if (user) {
          matchedUserId = user.id;
          matchedUserName = user.name || user.username || "Vô danh đạo hữu";
          this.logger.log(`Matched user: ${user.name} (${user.id}) for SePay transaction id=${payload.id}`);

          // Update user stats (safely handle decimal strings like "0.00" from postgres numeric columns)
          const toBigIntSafe = (val: unknown): bigint => {
            if (val === null || val === undefined) return BigInt(0);
            if (typeof val === "bigint") return val;
            if (typeof val === "number") return BigInt(Math.floor(val));
            const s = String(val).trim().split(".")[0];
            try {
              return BigInt(s || 0);
            } catch {
              return BigInt(0);
            }
          };

          const currentExp = toBigIntSafe(user.exp);
          const newExpBig = currentExp + toBigIntSafe(rewardExp);
          const newExp = newExpBig.toString();
          const currentDonated = toBigIntSafe(user.totalDonatedVnd);
          const newDonated = (currentDonated + toBigIntSafe(transferAmount)).toString();

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

          // Update SePay transaction record as SUCCESS
          txRecord.userId = user.id;
          txRecord.rewardExp = rewardExp;
          txRecord.status = SepayTransactionStatus.SUCCESS;
          txRecord.errorMessage = null;
          await manager.save(txRecord);
        } else {
          this.logger.warn(
            `No user matched for SePay transaction id=${payload.id}, memo="${payload.content}", code="${userCode}"`,
          );

          // Update as UNMATCHED transaction for admin inspection
          txRecord.userId = null;
          txRecord.rewardExp = 0;
          txRecord.status = SepayTransactionStatus.UNMATCHED;
          txRecord.errorMessage = null;
          await manager.save(txRecord);
        }
      });

      // 8. Send real-time notification to user via WebSocket if connected
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

      // 9. Send notification to Telegram Chat ID
      if (matchedUserId) {
        try {
          this.logger.log(`Calling telegramService.sendDonationSuccessNotification for matched user ${matchedUserId}`);
          const sent = await this.telegramService.sendDonationSuccessNotification({
            donorName: matchedUserName || "Vô danh đạo hữu",
            userCode: userCode || String(matchedUserId).slice(0, 8),
            amount: transferAmount,
            exp: rewardExp,
            transactionCode: `sepay_${payload.id}`,
            sepayId: String(payload.id),
            gateway: payload.gateway || payload.accountNumber,
            content: payload.content,
            transactionDate: payload.transactionDate,
          });
          if (!sent) {
            this.logger.warn("Telegram success notification was not sent (check Telegram credentials in DB platform)");
          }
        } catch (tgErr: any) {
          this.logger.warn(`Failed to dispatch Telegram success alert: ${tgErr?.message}`);
        }
      } else {
        try {
          this.logger.log(`Calling telegramService.sendDonationFailedNotification for UNMATCHED memo "${payload.content}"`);
          const sent = await this.telegramService.sendDonationFailedNotification({
            amount: transferAmount,
            error: `Không tìm thấy người dùng khớp với mã '${userCode || "N/A"}' trong nội dung chuyển khoản`,
            status: "UNMATCHED",
            userCode,
            sepayId: String(payload.id),
            transactionCode: `sepay_${payload.id}`,
            gateway: payload.gateway || payload.accountNumber,
            content: payload.content,
            transactionDate: payload.transactionDate,
          });
          if (!sent) {
            this.logger.warn("Telegram unmatched notification was not sent (check Telegram credentials in DB platform)");
          }
        } catch (tgErr: any) {
          this.logger.warn(`Failed to dispatch Telegram unmatched alert: ${tgErr?.message}`);
        }
      }

      return {
        success: true,
        message: matchedUserId ? "Donation processed and EXP awarded" : "Donation recorded as unmatched",
      };
    } catch (err: any) {
      this.logger.error(`Error executing SePay transaction id=${payload.id}: ${err?.message || err}`, err?.stack);

      try {
        txRecord.status = SepayTransactionStatus.FAILED;
        txRecord.errorMessage = err?.message || String(err);
        await txRepo.save(txRecord);
      } catch (saveErr: any) {
        this.logger.error(`Failed to save FAILED status for SePay transaction id=${payload.id}: ${saveErr?.message}`);
      }

      // Send Telegram alert for transaction processing failure
      try {
        await this.telegramService.sendDonationFailedNotification({
          amount: transferAmount,
          error: err?.message || String(err),
          status: "FAILED",
          userCode,
          sepayId: String(payload?.id || "N/A"),
          transactionCode: payload?.id ? `sepay_${payload.id}` : undefined,
          gateway: payload?.gateway || payload?.accountNumber,
          content: payload?.content,
          transactionDate: payload?.transactionDate,
        });
      } catch (tgErr: any) {
        this.logger.warn(`Failed to dispatch Telegram failure alert: ${tgErr?.message}`);
      }

      throw err;
    }
  }

  /**
   * Verify HMAC-SHA256 signature (X-SePay-Signature) or Authorization header against configured SePay Secret Key
   */
  private async verifyAuthentication(authContext?: SepayWebhookAuthContext | string): Promise<void> {
    const ctx: SepayWebhookAuthContext =
      typeof authContext === "string" ? { authHeader: authContext } : authContext || {};

    if (ctx.isInternalRetry) {
      this.logger.log("Bypassing webhook signature verification for internal retry request");
      return;
    }

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
        .createQueryBuilder("u")
        .where("REPLACE(u.id::text, '-', '') ILIKE :prefix", { prefix: `${cleanCode}%` })
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

  /**
   * Get list of SePay transactions with user profile and aggregate counts
   */
  async getTransactions(query?: {
    limit?: number;
    offset?: number;
    status?: string;
    search?: string;
  }): Promise<{
    items: any[];
    total: number;
    counts: {
      total: number;
      success: number;
      unmatched: number;
      failed: number;
      pending: number;
      ignored: number;
    };
  }> {
    const txRepo = this.dataSource.getRepository(FilmSepayTransaction);
    const limit = Math.min(Math.max(1, query?.limit || 50), 100);
    const offset = Math.max(0, query?.offset || 0);

    const qb = txRepo
      .createQueryBuilder("tx")
      .leftJoin(FilmUser, "u", "u.id = tx.userId")
      .select([
        "tx.id AS id",
        "tx.sepayId AS sepay_id",
        "tx.gateway AS gateway",
        "tx.transactionDate AS transaction_date",
        "tx.accountNumber AS account_number",
        "tx.subAccount AS sub_account",
        "tx.code AS code",
        "tx.content AS content",
        "tx.transferType AS transfer_type",
        "tx.description AS description",
        "tx.transferAmount AS transfer_amount",
        "tx.accumulated AS accumulated",
        "tx.referenceCode AS reference_code",
        "tx.userId AS user_id",
        "tx.rewardExp AS reward_exp",
        "tx.status AS status",
        "tx.errorMessage AS error_message",
        "tx.rawPayload AS raw_payload",
        "tx.createdAt AS created_at",
        "tx.updatedAt AS updated_at",
        "u.id AS user_user_id",
        "u.name AS user_name",
        "u.avatarUrl AS user_avatar_url",
        "u.avatarFrameId AS user_avatar_frame_id",
        "u.currentTitle AS user_current_title",
        "u.sectRank AS user_sect_rank",
      ])
      .orderBy("tx.createdAt", "DESC");

    if (query?.status) {
      qb.andWhere("tx.status = :status", { status: query.status.toUpperCase() });
    }

    if (query?.search) {
      const s = `%${query.search.trim()}%`;
      qb.andWhere(
        "(tx.content ILIKE :s OR tx.referenceCode ILIKE :s OR CAST(tx.sepayId AS text) ILIKE :s OR u.name ILIKE :s)",
        { s },
      );
    }

    // Counts by status
    const countRows = await txRepo
      .createQueryBuilder("tx")
      .select("tx.status", "status")
      .addSelect("COUNT(*)", "count")
      .groupBy("tx.status")
      .getRawMany();

    const counts = {
      total: 0,
      success: 0,
      unmatched: 0,
      failed: 0,
      pending: 0,
      ignored: 0,
    };

    for (const r of countRows) {
      const c = Number(r.count || 0);
      counts.total += c;
      const st = String(r.status || "").toLowerCase();
      if (st === "success") counts.success = c;
      else if (st === "unmatched") counts.unmatched = c;
      else if (st === "failed") counts.failed = c;
      else if (st === "pending") counts.pending = c;
      else if (st === "ignored") counts.ignored = c;
    }

    const total = await qb.getCount();
    const rawItems = await qb.offset(offset).limit(limit).getRawMany();

    // Map rawItems to clean items
    const items = await Promise.all(
      rawItems.map(async (row) => {
        let user = row.user_user_id
          ? {
              id: row.user_user_id,
              name: row.user_name,
              avatarUrl: row.user_avatar_url,
              avatarFrameId: row.user_avatar_frame_id,
              currentTitle: row.user_current_title,
              sectRank: row.user_sect_rank,
            }
          : null;

        // If user not linked yet (e.g. UNMATCHED or FAILED), try candidate lookup from memo
        if (!user) {
          const userCode = extractDonationUserCode({
            code: row.code,
            content: row.content,
            description: row.description,
          });
          if (userCode) {
            const candidate = await this.findUserByCode(this.dataSource.manager, userCode);
            if (candidate) {
              user = {
                id: candidate.id,
                name: candidate.name,
                avatarUrl: candidate.avatarUrl,
                avatarFrameId: candidate.avatarFrameId,
                currentTitle: candidate.currentTitle,
                sectRank: candidate.sectRank,
              };
            }
          }
        }

        return {
          id: row.id,
          sepayId: String(row.sepay_id),
          gateway: row.gateway,
          transactionDate: row.transaction_date,
          accountNumber: row.account_number,
          subAccount: row.sub_account,
          code: row.code,
          content: row.content,
          transferType: row.transfer_type,
          description: row.description,
          transferAmount: row.transfer_amount,
          accumulated: row.accumulated,
          referenceCode: row.reference_code,
          userId: row.user_id,
          rewardExp: Number(row.reward_exp || 0),
          status: row.status,
          errorMessage: row.error_message,
          rawPayload: row.raw_payload,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          user,
        };
      }),
    );

    return {
      items,
      total,
      counts,
    };
  }

  /**
   * Re-execute a previously failed or unmatched SePay transaction
   */
  async retryTransaction(idOrSepayId: string): Promise<{ success: boolean; message: string }> {
    const txRepo = this.dataSource.getRepository(FilmSepayTransaction);
    let tx = await txRepo.findOne({
      where: [{ id: idOrSepayId }],
    });
    if (!tx && !isNaN(Number(idOrSepayId))) {
      tx = await txRepo.findOne({
        where: [{ sepayId: idOrSepayId }],
      });
    }

    if (!tx) {
      throw new NotFoundException(`Giao dịch "${idOrSepayId}" không tồn tại trong hệ thống`);
    }

    if (!tx.rawPayload) {
      throw new BadRequestException("Giao dịch không có dữ liệu gốc (rawPayload) để chạy lại");
    }

    this.logger.log(`Re-executing SePay transaction id=${tx.sepayId}...`);
    return this.processWebhook(tx.rawPayload as any, { isInternalRetry: true });
  }
}
