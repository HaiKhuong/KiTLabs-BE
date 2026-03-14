import { Controller, Get, Param, Patch, UnauthorizedException } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { NotificationsService } from "./notifications.service";

@ApiTags("Notifications")
@ApiBearerAuth("bearer")
@Controller("tools/notifications")
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @ApiOperation({ summary: "List current user notifications" })
  @Get()
  async list(@CurrentUser() user: { userId: string } | undefined) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    return this.notificationsService.list(user.userId);
  }

  @ApiOperation({ summary: "Mark notification as read" })
  @ApiParam({ name: "notificationId", description: "Notification UUID" })
  @Patch(":notificationId/read")
  async markRead(@Param("notificationId") notificationId: string) {
    return this.notificationsService.markRead(notificationId);
  }
}
