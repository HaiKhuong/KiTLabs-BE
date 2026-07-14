import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { NotificationType } from "../../common/enums/domain.enums";
import { CreateNotificationDto } from "./dto/create-notification.dto";
import { NotificationsService } from "./notifications.service";

@ApiTags("Notifications")
@Controller("tools/notifications")
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @ApiOperation({ summary: "List notifications for a tools guest/user" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "limit", required: false })
  @Public()
  @Get()
  async list(@Query("userId") userId?: string, @Query("limit") limit?: string) {
    if (!userId?.trim()) {
      throw new BadRequestException("userId is required");
    }
    const parsedLimit = limit ? Number(limit) : 50;
    return this.notificationsService.list(
      userId.trim(),
      Number.isFinite(parsedLimit) ? parsedLimit : 50,
    );
  }

  @ApiOperation({ summary: "Unread notification count" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("unread-count")
  async unreadCount(@Query("userId") userId?: string) {
    if (!userId?.trim()) {
      throw new BadRequestException("userId is required");
    }
    const count = await this.notificationsService.unreadCount(userId.trim());
    return { count };
  }

  @ApiOperation({
    summary: "Create a client notification (queue done / queue error / user system note)",
  })
  @ApiBody({ type: CreateNotificationDto })
  @Public()
  @Post()
  async create(@Body() dto: CreateNotificationDto) {
    return this.notificationsService.push({
      userId: dto.userId,
      title: dto.title,
      message: dto.message,
      type: dto.type ?? NotificationType.INFO,
    });
  }

  @ApiOperation({ summary: "Mark all notifications as read" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Patch("read-all")
  async markAllRead(@Query("userId") userId?: string) {
    if (!userId?.trim()) {
      throw new BadRequestException("userId is required");
    }
    return this.notificationsService.markAllRead(userId.trim());
  }

  @ApiOperation({ summary: "Mark one notification as read" })
  @ApiParam({ name: "notificationId", description: "Notification UUID" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Patch(":notificationId/read")
  async markRead(
    @Param("notificationId") notificationId: string,
    @Query("userId") userId?: string,
  ) {
    if (!userId?.trim()) {
      throw new BadRequestException("userId is required");
    }
    const note = await this.notificationsService.markRead(notificationId, userId.trim());
    if (!note) {
      throw new NotFoundException("Notification not found");
    }
    return note;
  }
}
