import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { NotificationType } from "../../common/enums/domain.enums";
import { Notification } from "./notification.entity";

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification, "tool")
    private readonly notificationRepository: Repository<Notification>,
  ) {}

  async push(input: {
    userId: string;
    title: string;
    message: string;
    type?: NotificationType;
  }): Promise<Notification> {
    const note = this.notificationRepository.create({
      userId: input.userId,
      title: input.title,
      message: input.message,
      type: input.type ?? NotificationType.INFO,
      isRead: false,
    });
    return this.notificationRepository.save(note);
  }

  async markRead(notificationId: string): Promise<Notification | null> {
    const note = await this.notificationRepository.findOne({
      where: { id: notificationId },
    });
    if (!note) {
      return null;
    }
    note.isRead = true;
    return this.notificationRepository.save(note);
  }

  async list(userId: string): Promise<Notification[]> {
    return this.notificationRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }
}
