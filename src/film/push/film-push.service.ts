import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import * as fs from "fs";
import * as path from "path";
import { DataSource, In } from "typeorm";
import { FilmNotification, FilmPushPlatform, FilmPushToken } from "../entities/film.entities";

export const FILM_PUSH_QUEUE = "film-push";
const FCM_BATCH_SIZE = 500;
const INVALID_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

export interface FilmPushPayload {
  title: string;
  body: string;
  actionUrl?: string | null;
  type?: string;
  notificationId?: string;
}

export interface FilmPushJobData {
  kind: "broadcast" | "multicast";
  userIds?: string[];
  payload: FilmPushPayload;
}

@Injectable()
export class FilmPushService implements OnModuleInit {
  private readonly logger = new Logger(FilmPushService.name);
  private messaging: Messaging | null = null;

  constructor(
    @InjectDataSource("film") private readonly db: DataSource,
    @InjectQueue(FILM_PUSH_QUEUE) private readonly pushQueue: Queue<FilmPushJobData>,
  ) {}

  onModuleInit(): void {
    this.messaging = this.initializeFirebaseMessaging();
  }

  private initializeFirebaseMessaging(): Messaging | null {
    try {
      const existingApps = getApps();
      if (existingApps.length > 0) {
        return getMessaging(existingApps[0]);
      }

      const credential = this.loadServiceAccountCredential();
      if (!credential) {
        this.logger.warn(
          "Firebase Admin is not configured (set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY). FCM push dispatch is disabled.",
        );
        return null;
      }

      const app = initializeApp({
        credential: cert(credential),
      });
      this.logger.log("Firebase Admin Messaging initialized");
      return getMessaging(app);
    } catch (error) {
      this.logger.warn(`Failed to initialize Firebase Admin: ${(error as Error).message}`);
      return null;
    }
  }

  private loadServiceAccountCredential(): ServiceAccount | null {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
    if (serviceAccountPath) {
      const resolvedPath = path.isAbsolute(serviceAccountPath)
        ? serviceAccountPath
        : path.resolve(process.cwd(), serviceAccountPath);
      if (fs.existsSync(resolvedPath)) {
        return JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as ServiceAccount;
      }
      this.logger.warn(`FIREBASE_SERVICE_ACCOUNT_PATH not found: ${resolvedPath}`);
    }

    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();

    if (projectId && clientEmail && privateKey) {
      return { projectId, clientEmail, privateKey };
    }

    return null;
  }

  async registerToken(
    userId: string,
    deviceId: string | null,
    token: string,
    platform: FilmPushPlatform = FilmPushPlatform.WEB,
    userAgent: string | null = null,
  ) {
    const repo = this.db.getRepository(FilmPushToken);
    const trimmedToken = token.trim();
    const existing = await repo.findOne({ where: { token: trimmedToken }, withDeleted: true });
    const now = new Date();

    if (existing) {
      existing.userId = userId;
      existing.deviceId = deviceId;
      existing.platform = platform;
      existing.userAgent = userAgent;
      existing.isActive = true;
      existing.lastUsedAt = now;
      existing.deletedAt = null;
      return repo.save(existing);
    }

    const created = repo.create({
      userId,
      deviceId,
      token: trimmedToken,
      platform,
      userAgent,
      isActive: true,
      lastUsedAt: now,
    });
    return repo.save(created);
  }

  async unregisterToken(userId: string, token: string) {
    const repo = this.db.getRepository(FilmPushToken);
    const existing = await repo.findOne({ where: { token: token.trim(), userId } });
    if (!existing) {
      return { updated: false };
    }
    existing.isActive = false;
    await repo.save(existing);
    return { updated: true };
  }

  async hasActiveTokenForUser(userId: string): Promise<boolean> {
    const trimmed = String(userId || "").trim();
    if (!trimmed) return false;
    const count = await this.db.getRepository(FilmPushToken).count({
      where: { userId: trimmed, isActive: true },
    });
    return count > 0;
  }

  async enqueueBroadcast(payload: FilmPushPayload) {
    return this.pushQueue.add(
      "broadcast",
      { kind: "broadcast", payload },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
  }

  async enqueueToUsers(userIds: string[], payload: FilmPushPayload) {
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
    if (uniqueUserIds.length === 0) {
      return this.enqueueBroadcast(payload);
    }
    return this.pushQueue.add(
      "multicast",
      { kind: "multicast", userIds: uniqueUserIds, payload },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
  }

  async createAndDispatchNotification(input: {
    title: string;
    content: string;
    type?: string;
    actionUrl?: string | null;
    userIds?: string[];
    sendPush?: boolean;
  }) {
    const notifRepo = this.db.getRepository(FilmNotification);
    const type = input.type?.trim() || "SYSTEM";
    const actionUrl = input.actionUrl?.trim() || null;
    const targetUserIds = [...new Set((input.userIds || []).filter(Boolean))];

    let savedNotifications: FilmNotification[];
    if (targetUserIds.length > 0) {
      const rows = targetUserIds.map((userId) =>
        notifRepo.create({
          userId,
          type,
          title: input.title,
          content: input.content,
          actionUrl,
          isRead: false,
        }),
      );
      savedNotifications = await notifRepo.save(rows);
    } else {
      const row = await notifRepo.save(
        notifRepo.create({
          userId: null,
          type,
          title: input.title,
          content: input.content,
          actionUrl,
          isRead: false,
        }),
      );
      savedNotifications = [row];
    }

    let queued = false;
    if (input.sendPush !== false) {
      const pushPayload: FilmPushPayload = {
        title: input.title,
        body: input.content,
        actionUrl,
        type,
        notificationId: savedNotifications[0]?.id,
      };
      if (targetUserIds.length > 0) {
        await this.enqueueToUsers(targetUserIds, pushPayload);
      } else {
        await this.enqueueBroadcast(pushPayload);
      }
      queued = true;
    }

    return {
      notifications: savedNotifications,
      pushQueued: queued,
    };
  }

  async dispatchJob(data: FilmPushJobData): Promise<{ sent: number; failed: number; totalTokens: number }> {
    if (!this.messaging) {
      this.logger.warn("Skip FCM dispatch: Firebase Admin Messaging is not initialized");
      return { sent: 0, failed: 0, totalTokens: 0 };
    }

    const repo = this.db.getRepository(FilmPushToken);
    const tokens = await repo.find({
      where:
        data.kind === "multicast" && data.userIds?.length
          ? { isActive: true, userId: In(data.userIds) }
          : { isActive: true },
      select: ["id", "token"],
    });

    if (tokens.length === 0) {
      return { sent: 0, failed: 0, totalTokens: 0 };
    }

    let sent = 0;
    let failed = 0;
    const invalidTokens: string[] = [];

    for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
      const batch = tokens.slice(i, i + FCM_BATCH_SIZE);
      const tokenStrings = batch.map((item) => item.token);

      const response = await this.messaging.sendEachForMulticast({
        tokens: tokenStrings,
        data: {
          title: data.payload.title,
          body: data.payload.body,
          actionUrl: data.payload.actionUrl || "/",
          type: data.payload.type || "SYSTEM",
          ...(data.payload.notificationId ? { notificationId: data.payload.notificationId } : {}),
        },
        webpush: {
          fcmOptions: {
            link: data.payload.actionUrl || "/",
          },
        },
      });

      sent += response.successCount;
      failed += response.failureCount;

      response.responses.forEach((item, index) => {
        if (!item.success && item.error?.code && INVALID_TOKEN_ERROR_CODES.has(item.error.code)) {
          invalidTokens.push(tokenStrings[index]);
        }
      });
    }

    if (invalidTokens.length > 0) {
      await repo.update({ token: In(invalidTokens) }, { isActive: false });
      this.logger.log(`Deactivated ${invalidTokens.length} invalid/unregistered FCM tokens`);
    }

    return { sent, failed, totalTokens: tokens.length };
  }
}
