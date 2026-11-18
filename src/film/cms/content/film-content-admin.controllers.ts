import { Body, Controller, Optional, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { FilmNotice } from "../../entities/film.entities";
import { FilmChatGateway } from "../../film-chat.gateway";
import { FilmChatService } from "../../guest/chat/film-chat.service";
import { SendFilmPushNotificationDto } from "../../push/dto/push-token.dto";
import { FilmPushService } from "../../push/film-push.service";
import { FilmAdminService } from "../shared/film-admin.service";
import { FilmCmsAccess } from "../shared/film-cms.decorators";
import { FilmAdminPayloadDto, FilmCrudController } from "../shared/film-crud.controller";

@FilmCmsAccess()
@ApiTags("Film CMS - Items")
@Controller("film/admin/items")
export class FilmItemsAdminController extends FilmCrudController {
  protected readonly resource = "items";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Banners")
@Controller("film/admin/banners")
export class FilmBannersAdminController extends FilmCrudController {
  protected readonly resource = "banners";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Notices")
@Controller("film/admin/notices")
export class FilmNoticesAdminController extends FilmCrudController {
  protected readonly resource = "notices";
  constructor(
    s: FilmAdminService,
    @Optional() private readonly chatService?: FilmChatService,
    @Optional() private readonly chatGateway?: FilmChatGateway,
  ) {
    super(s);
  }

  @ApiOperation({ summary: "Create notice and broadcast to world chat once" })
  @Post()
  override async create(@Body() dto: FilmAdminPayloadDto) {
    const created = (await this.service.adminCreate(this.resource, dto.data)) as FilmNotice;
    if (created && created.isActive !== false && this.chatService) {
      try {
        const chatMsg = await this.chatService.createSystemNoticeMessage(created);
        this.chatGateway?.broadcastMessage("WORLD_GENERAL", chatMsg);
      } catch {
        // Do not fail notice creation if chat broadcast fails
      }
    }
    return created;
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Advertisements")
@Controller("film/admin/advertisements")
export class FilmAdvertisementsAdminController extends FilmCrudController {
  protected readonly resource = "advertisements";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Notifications")
@Controller("film/admin/notifications")
export class FilmNotificationsAdminController extends FilmCrudController {
  protected readonly resource = "notifications";
  constructor(
    s: FilmAdminService,
    private readonly pushService: FilmPushService,
  ) {
    super(s);
  }

  @ApiOperation({ summary: "Create notification and dispatch FCM web/PWA push" })
  @Post("send")
  sendNotification(@Body() dto: SendFilmPushNotificationDto) {
    return this.pushService.createAndDispatchNotification({
      title: dto.title,
      content: dto.content,
      type: dto.type,
      actionUrl: dto.actionUrl,
      userIds: dto.userIds,
      sendPush: dto.sendPush,
    });
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Settings")
@Controller("film/admin/settings")
export class FilmSettingsAdminController extends FilmCrudController {
  protected readonly resource = "settings";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Reports")
@Controller("film/admin/reports")
export class FilmReportsAdminController extends FilmCrudController {
  protected readonly resource = "reports";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Image Upload Histories")
@Controller("film/admin/image-uploads")
export class FilmUploadsAdminController extends FilmCrudController {
  protected readonly resource = "image-uploads";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Missions")
@Controller("film/admin/missions")
export class FilmMissionsAdminController extends FilmCrudController {
  protected readonly resource = "missions";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

export const FILM_CONTENT_ADMIN_CONTROLLERS = [
  FilmItemsAdminController,
  FilmBannersAdminController,
  FilmNoticesAdminController,
  FilmAdvertisementsAdminController,
  FilmNotificationsAdminController,
  FilmSettingsAdminController,
  FilmReportsAdminController,
  FilmUploadsAdminController,
  FilmMissionsAdminController,
];
