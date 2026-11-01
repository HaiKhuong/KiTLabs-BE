import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { RedisService } from "../../../database/redis.service";
import {
  FilmMission,
  FilmUser,
  FilmUserExpHistory,
  FilmUserMissionProgress,
  FilmUserReferral,
  UserMissionStatus,
} from "../../entities/film.entities";
import { filmRankFor } from "../../shared/film-rank.util";
import { ExpHistoryQueryDto } from "./dto/exp-history-query.dto";
import { WatchHeartbeatDto } from "./dto/watch-heartbeat.dto";

const DEFAULT_MISSIONS: Array<{
  code: string;
  title: string;
  description: string;
  rewardExp: number;
  maxDailyReward: number | null;
  targetCount: number;
  targetUnit: string;
  resetDaily: boolean;
  displayOrder: number;
}> = [
  {
    code: "DAILY_CHECKIN",
    title: "Điểm danh hàng ngày",
    description: "Vào trang mỗi ngày để tích lũy tu vi và nhận phần thưởng tu tiên.",
    rewardExp: 10,
    maxDailyReward: 10,
    targetCount: 1,
    targetUnit: "lần",
    resetDaily: true,
    displayOrder: 1,
  },
  {
    code: "INTERACTIVE_COMMENT",
    title: "Bình luận tương tác",
    description: "Để lại bình luận luận đạo dưới các bộ phim yêu thích (+10 EXP/lần, tối đa 3 lần/ngày).",
    rewardExp: 10,
    maxDailyReward: 30,
    targetCount: 3,
    targetUnit: "bình luận",
    resetDaily: true,
    displayOrder: 2,
  },
  {
    code: "SHARE_LINK_REF",
    title: "Chia sẻ link phim (Ref)",
    description: "Chia sẻ liên kết phim kèm mã giới thiệu đến đạo hữu khác để nhận thưởng khi có người click xem.",
    rewardExp: 15,
    maxDailyReward: null,
    targetCount: 1,
    targetUnit: "lượt",
    resetDaily: false,
    displayOrder: 3,
  },
  {
    code: "WATCH_MOVIE_TIME",
    title: "Xem phim tích lũy",
    description: "Xem phim mỗi ngày để tích lũy chân khí (+1 EXP / phút, tối đa 180 phút/ngày).",
    rewardExp: 1,
    maxDailyReward: 180,
    targetCount: 180,
    targetUnit: "phút",
    resetDaily: true,
    displayOrder: 4,
  },
  {
    code: "DONATE_BANK",
    title: "Donate ủng hộ ngân hàng",
    description: "Ủng hộ ngân quỹ duy trì máy chủ tu tiên (Quy đổi +3 EXP / 1.000đ, không giới hạn).",
    rewardExp: 3,
    maxDailyReward: null,
    targetCount: 0,
    targetUnit: "1.000đ",
    resetDaily: false,
    displayOrder: 5,
  },
];

@Injectable()
export class FilmMissionService implements OnModuleInit {
  private readonly logger = new Logger(FilmMissionService.name);

  constructor(
    @InjectDataSource("film") private readonly dataSource: DataSource,
    @InjectRepository(FilmMission, "film")
    private readonly missionRepo: Repository<FilmMission>,
    @InjectRepository(FilmUserMissionProgress, "film")
    private readonly progressRepo: Repository<FilmUserMissionProgress>,
    @InjectRepository(FilmUserExpHistory, "film")
    private readonly expHistoryRepo: Repository<FilmUserExpHistory>,
    @InjectRepository(FilmUserReferral, "film")
    private readonly referralRepo: Repository<FilmUserReferral>,
    @InjectRepository(FilmUser, "film")
    private readonly userRepo: Repository<FilmUser>,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureDefaultMissions();
    } catch (error) {
      this.logger.warn(`Failed to seed default missions: ${(error as Error).message}`);
    }
  }

  getTodayDateKey(): string {
    const now = new Date();
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(now);
  }

  private async ensureDefaultMissions() {
    for (const item of DEFAULT_MISSIONS) {
      const existing = await this.missionRepo.findOne({ where: { code: item.code } });
      if (!existing) {
        await this.missionRepo.save(this.missionRepo.create({ ...item, isActive: true }));
      }
    }
  }

  async getMissionsWithProgress(userId: string) {
    const today = this.getTodayDateKey();
    const missions = await this.missionRepo.find({
      where: { isActive: true },
      order: { displayOrder: "ASC" },
    });

    const userProgressList = await this.progressRepo.find({
      where: [
        { userId, dateKey: today },
        { userId, dateKey: "ALL" },
      ],
    });

    const progressMap = new Map<string, FilmUserMissionProgress>();
    for (const p of userProgressList) {
      progressMap.set(p.missionCode, p);
    }

    // Get unsynced watch minutes from Redis for this user today
    let redisUnsyncedMinutes = 0;
    try {
      const raw = await this.redis.hget(`film:watch:minutes_today:${today}`, userId);
      if (raw) redisUnsyncedMinutes = Number(raw) || 0;
    } catch (e) {
      this.logger.warn(`Redis hget error: ${(e as Error).message}`);
    }

    return missions.map((mission) => {
      const p = progressMap.get(mission.code);
      let currentCount = p?.currentCount || 0;
      let claimedExp = p?.claimedExp || 0;

      if (mission.code === "WATCH_MOVIE_TIME") {
        currentCount = Math.min(180, currentCount + redisUnsyncedMinutes);
      }

      // Calculate claimable EXP amount
      let claimableExp = 0;
      let status: UserMissionStatus = UserMissionStatus.IN_PROGRESS;

      if (mission.code === "DAILY_CHECKIN") {
        if (currentCount >= 1 && claimedExp === 0) {
          claimableExp = mission.rewardExp;
          status = UserMissionStatus.CLAIMABLE;
        } else if (claimedExp >= mission.rewardExp) {
          status = UserMissionStatus.CLAIMED;
        }
      } else if (mission.code === "INTERACTIVE_COMMENT") {
        const totalEarnedExp = Math.min(currentCount * mission.rewardExp, mission.maxDailyReward || 30);
        claimableExp = Math.max(0, totalEarnedExp - claimedExp);
        if (claimableExp > 0) {
          status = UserMissionStatus.CLAIMABLE;
        } else if (claimedExp >= (mission.maxDailyReward || 30)) {
          status = UserMissionStatus.CLAIMED;
        }
      } else if (mission.code === "SHARE_LINK_REF") {
        const totalEarnedExp = currentCount * mission.rewardExp;
        claimableExp = Math.max(0, totalEarnedExp - claimedExp);
        if (claimableExp > 0) {
          status = UserMissionStatus.CLAIMABLE;
        } else if (currentCount > 0 && claimedExp >= totalEarnedExp) {
          status = UserMissionStatus.CLAIMED;
        }
      } else if (mission.code === "WATCH_MOVIE_TIME") {
        const totalEarnedExp = Math.min(currentCount * mission.rewardExp, mission.maxDailyReward || 180);
        claimableExp = Math.max(0, totalEarnedExp - claimedExp);
        if (claimableExp > 0) {
          status = UserMissionStatus.CLAIMABLE;
        } else if (claimedExp >= (mission.maxDailyReward || 180)) {
          status = UserMissionStatus.CLAIMED;
        }
      } else if (mission.code === "DONATE_BANK") {
        status = UserMissionStatus.IN_PROGRESS;
      }

      return {
        id: mission.id,
        code: mission.code,
        title: mission.title,
        description: mission.description,
        rewardExp: mission.rewardExp,
        maxDailyReward: mission.maxDailyReward,
        targetCount: mission.targetCount,
        targetUnit: mission.targetUnit,
        resetDaily: mission.resetDaily,
        currentCount,
        claimedExp,
        claimableExp,
        status,
      };
    });
  }

  async claimMission(userId: string, missionCode: string) {
    const today = this.getTodayDateKey();
    const mission = await this.missionRepo.findOne({ where: { code: missionCode, isActive: true } });
    if (!mission) throw new BadRequestException("Nhiệm vụ không tồn tại");

    const dateKey = mission.resetDaily ? today : "ALL";
    let progress = await this.progressRepo.findOne({
      where: { userId, missionCode, dateKey },
    });

    // Check watch time unsynced from Redis if needed
    if (missionCode === "WATCH_MOVIE_TIME") {
      try {
        const raw = await this.redis.hget(`film:watch:minutes_today:${today}`, userId);
        if (raw) {
          const unsynced = Number(raw) || 0;
          if (unsynced > 0) {
            if (!progress) {
              progress = this.progressRepo.create({
                userId,
                missionCode,
                dateKey,
                currentCount: Math.min(180, unsynced),
                claimedExp: 0,
                status: UserMissionStatus.CLAIMABLE,
              });
            } else {
              progress.currentCount = Math.min(180, progress.currentCount + unsynced);
            }
            await this.progressRepo.save(progress);
            await this.redis.del(`film:watch:minutes_today:${today}`);
          }
        }
      } catch (e) {
        this.logger.warn(`Watch sync claim error: ${(e as Error).message}`);
      }
    }

    if (!progress) {
      throw new BadRequestException("Bạn chưa có tiến độ để nhận thưởng nhiệm vụ này");
    }

    let claimableExp = 0;
    if (missionCode === "DAILY_CHECKIN") {
      if (progress.currentCount >= 1 && progress.claimedExp === 0) {
        claimableExp = mission.rewardExp;
      }
    } else if (missionCode === "INTERACTIVE_COMMENT") {
      const maxExp = mission.maxDailyReward || 30;
      const totalEarned = Math.min(progress.currentCount * mission.rewardExp, maxExp);
      claimableExp = Math.max(0, totalEarned - progress.claimedExp);
    } else if (missionCode === "SHARE_LINK_REF") {
      const totalEarned = progress.currentCount * mission.rewardExp;
      claimableExp = Math.max(0, totalEarned - progress.claimedExp);
    } else if (missionCode === "WATCH_MOVIE_TIME") {
      const maxExp = mission.maxDailyReward || 180;
      const totalEarned = Math.min(progress.currentCount * mission.rewardExp, maxExp);
      claimableExp = Math.max(0, totalEarned - progress.claimedExp);
    }

    if (claimableExp <= 0) {
      throw new BadRequestException("Không có điểm thưởng nào khả dụng để nhận lúc này");
    }

    return this.dataSource.transaction(async (manager) => {
      progress.claimedExp += claimableExp;
      const maxReward = mission.maxDailyReward;
      if (maxReward && progress.claimedExp >= maxReward) {
        progress.status = UserMissionStatus.CLAIMED;
      } else if (
        !maxReward &&
        mission.targetCount > 0 &&
        progress.currentCount >= mission.targetCount
      ) {
        progress.status = UserMissionStatus.CLAIMED;
      }
      await manager.save(progress);

      const user = await manager.findOne(FilmUser, { where: { id: userId } });
      if (!user) throw new BadRequestException("Người dùng không tồn tại");

      const newExp = (BigInt(user.exp || 0) + BigInt(claimableExp)).toString();
      const newRank = filmRankFor(Number(newExp));
      user.exp = newExp;
      user.sectRank = newRank;
      await manager.save(user);

      // Record to EXP History
      const history = manager.create(FilmUserExpHistory, {
        userId,
        missionCode,
        amount: claimableExp,
        balanceAfter: newExp,
        title: mission.title,
        description: `Nhận thưởng ${claimableExp} EXP từ nhiệm vụ "${mission.title}"`,
        rawData: {
          claimedAt: new Date().toISOString(),
          missionCode,
          currentCount: progress.currentCount,
          dateKey,
        },
      });
      await manager.save(history);

      return {
        success: true,
        missionCode,
        claimedExp: claimableExp,
        newTotalExp: newExp,
        newSectRank: newRank,
      };
    });
  }

  async getExpHistory(userId: string, query: ExpHistoryQueryDto) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await this.expHistoryRepo.findAndCount({
      where: { userId },
      order: { createdAt: "DESC" },
      skip,
      take: limit,
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async handleWatchHeartbeat(userId: string, dto: WatchHeartbeatDto, ip: string, userAgent: string) {
    if (!dto.activeTab) {
      return { status: "ignored_inactive_tab" };
    }

    const today = this.getTodayDateKey();
    const lastPingKey = `film:watch:last_ping:${userId}`;
    const now = Date.now();

    try {
      const lastPing = await this.redis.get(lastPingKey);
      if (lastPing && now - Number(lastPing) < 55_000) {
        return { status: "rate_limited", waitSeconds: Math.ceil((55_000 - (now - Number(lastPing))) / 1000) };
      }

      await this.redis.set(lastPingKey, now.toString(), 7200);

      // Store raw ping log into Redis List
      const rawLog = JSON.stringify({
        timestamp: now,
        movieId: dto.movieId,
        episodeId: dto.episodeId,
        currentSeconds: dto.currentSeconds,
        ip,
        userAgent,
      });

      await this.redis.rpush(`film:watch:raw_logs:${today}:${userId}`, rawLog);
      await this.redis.expire(`film:watch:raw_logs:${today}:${userId}`, 86400 * 2);

      // Increment temporary minute counter
      await this.redis.hincrby(`film:watch:minutes_today:${today}`, userId, 1);
      await this.redis.expire(`film:watch:minutes_today:${today}`, 86400 * 2);

      // Mark user for scheduled sync
      await this.redis.sadd(`film:watch:pending_sync:${today}`, userId);
      await this.redis.expire(`film:watch:pending_sync:${today}`, 86400 * 2);

      return { status: "recorded" };
    } catch (error) {
      this.logger.error(`Watch heartbeat error: ${(error as Error).message}`);
      return { status: "error" };
    }
  }

  @Cron("*/5 * * * *")
  async syncWatchMinutesJob() {
    const today = this.getTodayDateKey();
    const syncSetKey = `film:watch:pending_sync:${today}`;

    try {
      const userIds = await this.redis.smembers(syncSetKey);
      if (!userIds || userIds.length === 0) return;

      this.logger.log(`Syncing watch time for ${userIds.length} users...`);

      for (const userId of userIds) {
        try {
          const rawMinutes = await this.redis.hget(`film:watch:minutes_today:${today}`, userId);
          if (!rawMinutes) continue;

          const addedMinutes = Number(rawMinutes) || 0;
          if (addedMinutes <= 0) continue;

          const rawLogs = await this.redis.lrange(`film:watch:raw_logs:${today}:${userId}`, 0, -1);
          const parsedLogs = rawLogs.map((item) => {
            try {
              return JSON.parse(item);
            } catch {
              return item;
            }
          });

          let progress = await this.progressRepo.findOne({
            where: { userId, missionCode: "WATCH_MOVIE_TIME", dateKey: today },
          });

          if (!progress) {
            progress = this.progressRepo.create({
              userId,
              missionCode: "WATCH_MOVIE_TIME",
              dateKey: today,
              currentCount: Math.min(180, addedMinutes),
              claimedExp: 0,
              status: UserMissionStatus.IN_PROGRESS,
              metadata: { rawLogsCount: parsedLogs.length, latestRawLog: parsedLogs[parsedLogs.length - 1] },
            });
          } else {
            progress.currentCount = Math.min(180, progress.currentCount + addedMinutes);
            progress.metadata = {
              ...(progress.metadata || {}),
              rawLogsCount: parsedLogs.length,
              lastSyncedAt: new Date().toISOString(),
            };
          }

          if (progress.currentCount > progress.claimedExp) {
            progress.status = UserMissionStatus.CLAIMABLE;
          }
          await this.progressRepo.save(progress);

          // Update totalViewMinutes on FilmUser
          const user = await this.userRepo.findOne({ where: { id: userId } });
          if (user) {
            user.totalViewMinutes = (BigInt(user.totalViewMinutes || 0) + BigInt(addedMinutes)).toString();
            await this.userRepo.save(user);
          }

          // Remove processed user from Redis sync set
          await this.redis.srem(syncSetKey, userId);
          await this.redis.hincrby(`film:watch:minutes_today:${today}`, userId, -addedMinutes);
        } catch (itemErr) {
          this.logger.error(`Failed to sync watch minutes for user ${userId}: ${(itemErr as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error in syncWatchMinutesJob: ${(error as Error).message}`);
    }
  }

  async recordCheckin(userId: string) {
    const today = this.getTodayDateKey();
    try {
      let progress = await this.progressRepo.findOne({
        where: { userId, missionCode: "DAILY_CHECKIN", dateKey: today },
      });

      if (!progress) {
        progress = this.progressRepo.create({
          userId,
          missionCode: "DAILY_CHECKIN",
          dateKey: today,
          currentCount: 1,
          claimedExp: 0,
          status: UserMissionStatus.CLAIMABLE,
          metadata: { checkinTime: new Date().toISOString() },
        });
        await this.progressRepo.save(progress);
      }
    } catch (e) {
      this.logger.warn(`Checkin error for user ${userId}: ${(e as Error).message}`);
    }
  }

  async recordComment(userId: string) {
    const today = this.getTodayDateKey();
    try {
      let progress = await this.progressRepo.findOne({
        where: { userId, missionCode: "INTERACTIVE_COMMENT", dateKey: today },
      });

      if (!progress) {
        progress = this.progressRepo.create({
          userId,
          missionCode: "INTERACTIVE_COMMENT",
          dateKey: today,
          currentCount: 1,
          claimedExp: 0,
          status: UserMissionStatus.CLAIMABLE,
        });
      } else {
        if (progress.currentCount < 3) {
          progress.currentCount += 1;
          progress.status = UserMissionStatus.CLAIMABLE;
        }
      }
      await this.progressRepo.save(progress);
    } catch (e) {
      this.logger.warn(`Comment mission error: ${(e as Error).message}`);
    }
  }

  async recordReferral(
    referrerUserId: string,
    refereeUserId: string,
    ip: string | undefined,
    deviceToken: string,
  ) {
    if (!referrerUserId || !refereeUserId || referrerUserId === refereeUserId) {
      return { success: false, reason: "self_referral" };
    }

    try {
      // Check if referrer exists
      const referrer = await this.userRepo.findOne({ where: { id: referrerUserId } });
      if (!referrer) return { success: false, reason: "referrer_not_found" };

      // Anti-cheat 1: Check if referee already referred by this user
      const existingRef = await this.referralRepo.findOne({
        where: { referrerUserId, refereeUserId },
      });
      if (existingRef) return { success: false, reason: "already_referred" };

      // Anti-cheat 2: Check if IP already recorded for this referrer
      if (ip) {
        const existingIp = await this.referralRepo.findOne({
          where: { referrerUserId, ipAddress: ip },
        });
        if (existingIp) return { success: false, reason: "ip_already_referred" };
      }

      // Save referral
      await this.referralRepo.save(
        this.referralRepo.create({
          referrerUserId,
          refereeUserId,
          ipAddress: ip || null,
          deviceToken: deviceToken || null,
        }),
      );

      // Increment progress for referrer
      let progress = await this.progressRepo.findOne({
        where: { userId: referrerUserId, missionCode: "SHARE_LINK_REF", dateKey: "ALL" },
      });

      if (!progress) {
        progress = this.progressRepo.create({
          userId: referrerUserId,
          missionCode: "SHARE_LINK_REF",
          dateKey: "ALL",
          currentCount: 1,
          claimedExp: 0,
          status: UserMissionStatus.CLAIMABLE,
        });
      } else {
        progress.currentCount += 1;
        progress.status = UserMissionStatus.CLAIMABLE;
      }
      await this.progressRepo.save(progress);

      return { success: true };
    } catch (e) {
      this.logger.warn(`Referral error: ${(e as Error).message}`);
      return { success: false, reason: (e as Error).message };
    }
  }
}

