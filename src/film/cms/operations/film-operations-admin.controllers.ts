import { Controller } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { FilmAdminService } from "../shared/film-admin.service";
import { FilmCmsAccess } from "../shared/film-cms.decorators";
import { FilmCrudController } from "../shared/film-crud.controller";

@FilmCmsAccess()
@ApiTags("Film CMS - Users")
@Controller("film/admin/users")
export class FilmUsersAdminController extends FilmCrudController {
  protected readonly resource = "users";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Devices")
@Controller("film/admin/devices")
export class FilmDevicesAdminController extends FilmCrudController {
  protected readonly resource = "devices";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Donations")
@Controller("film/admin/donations")
export class FilmDonationsAdminController extends FilmCrudController {
  protected readonly resource = "donations";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Activity Logs")
@Controller("film/admin/activity-logs")
export class FilmActivityLogsAdminController extends FilmCrudController {
  protected readonly resource = "activity-logs";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Chat")
@Controller("film/admin/chat-messages")
export class FilmChatAdminController extends FilmCrudController {
  protected readonly resource = "chat-messages";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Watch Histories")
@Controller("film/admin/watch-histories")
export class FilmWatchAdminController extends FilmCrudController {
  protected readonly resource = "watch-histories";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Favorites")
@Controller("film/admin/favorites")
export class FilmFavoritesAdminController extends FilmCrudController {
  protected readonly resource = "favorites";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Ratings")
@Controller("film/admin/ratings")
export class FilmRatingsAdminController extends FilmCrudController {
  protected readonly resource = "ratings";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Comments")
@Controller("film/admin/comments")
export class FilmCommentsAdminController extends FilmCrudController {
  protected readonly resource = "comments";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

@FilmCmsAccess()
@ApiTags("Film CMS - Inventories")
@Controller("film/admin/inventories")
export class FilmInventoriesAdminController extends FilmCrudController {
  protected readonly resource = "inventories";
  constructor(s: FilmAdminService) {
    super(s);
  }
}

export const FILM_OPERATIONS_ADMIN_CONTROLLERS = [
  FilmUsersAdminController,
  FilmDevicesAdminController,
  FilmDonationsAdminController,
  FilmActivityLogsAdminController,
  FilmChatAdminController,
  FilmWatchAdminController,
  FilmFavoritesAdminController,
  FilmRatingsAdminController,
  FilmCommentsAdminController,
  FilmInventoriesAdminController,
];
