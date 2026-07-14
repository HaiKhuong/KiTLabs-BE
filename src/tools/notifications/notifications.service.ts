import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { NotificationType } from "../../common/enums/domain.enums";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { Notification } from "./notification.entity";
import { mapNotificationForClient, toPublicErrorMessage } from "./notification.utils";

export const NOTIFICATION_CREATED_EVENT = "notification.created";
export const NOTIFICATION_SYSTEM_EVENT = "notification.system";

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification, "tool")
    private readonly notificationRepository: Repository<Notification>,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {}

  async push(input: {
    userId: string;
    title: string;
    message: string;
    type?: NotificationType;
  }): Promise<ReturnType<typeof mapNotificationForClient>> {
    const note = this.notificationRepository.create({
      userId: input.userId,
      title: input.title.trim().slice(0, 255),
      message: input.message.trim(),
      type: input.type ?? NotificationType.INFO,
      isRead: false,
    });
    const saved = await this.notificationRepository.save(note);
    this.emitCreated(saved);
    return mapNotificationForClient(saved);
  }

  /** Thành công — title/message do caller soạn (tiếng Việt). */
  async pushSuccess(
    userId: string,
    title: string,
    message: string,
  ): Promise<ReturnType<typeof mapNotificationForClient>> {
    return this.push({ userId, title, message, type: NotificationType.SUCCESS });
  }

  /**
   * Lỗi người dùng — tự lọc message hệ thống.
   * `detail` chỉ hiện khi đã sạch; nếu thô hệ thống thì dùng fallback.
   */
  async pushError(
    userId: string,
    title: string,
    rawError: unknown,
    fallback = "Đã xảy ra lỗi khi xử lý. Vui lòng thử lại.",
  ): Promise<ReturnType<typeof mapNotificationForClient>> {
    return this.push({
      userId,
      title,
      message: toPublicErrorMessage(rawError, fallback),
      type: NotificationType.ERROR,
    });
  }

  async pushWarning(
    userId: string,
    title: string,
    message: string,
  ): Promise<ReturnType<typeof mapNotificationForClient>> {
    return this.push({ userId, title, message, type: NotificationType.WARNING });
  }

  /** Thông báo hệ thống: broadcast toàn cục, hoặc lưu theo user nếu có userId. */
  async pushSystem(input: {
    title: string;
    message: string;
    userId?: string;
  }): Promise<ReturnType<typeof mapNotificationForClient> | null> {
    if (input.userId?.trim()) {
      return this.push({
        userId: input.userId.trim(),
        title: input.title,
        message: input.message,
        type: NotificationType.INFO,
      });
    }

    this.realtimeGateway.notifyUser("all", NOTIFICATION_SYSTEM_EVENT, {
      id: `sys-${Date.now()}`,
      userId: "all",
      type: NotificationType.INFO,
      title: input.title.trim().slice(0, 255),
      message: input.message.trim(),
      isRead: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      system: true,
    });
    return null;
  }

  async markRead(notificationId: string, userId: string): Promise<Notification | null> {
    const note = await this.notificationRepository.findOne({
      where: { id: notificationId, userId },
    });
    if (!note) {
      return null;
    }
    note.isRead = true;
    return this.notificationRepository.save(note);
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.notificationRepository.update(
      { userId, isRead: false },
      { isRead: true },
    );
    return { updated: result.affected ?? 0 };
  }

  async list(userId: string, limit = 50): Promise<ReturnType<typeof mapNotificationForClient>[]> {
    const take = Math.min(100, Math.max(1, limit));
    const rows = await this.notificationRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
      take,
    });
    return rows.map(mapNotificationForClient);
  }

  async unreadCount(userId: string): Promise<number> {
    return this.notificationRepository.count({ where: { userId, isRead: false } });
  }

  private emitCreated(note: Notification): void {
    this.realtimeGateway.notifyUser(note.userId, NOTIFICATION_CREATED_EVENT, {
      ...mapNotificationForClient(note),
    });
  }
}
