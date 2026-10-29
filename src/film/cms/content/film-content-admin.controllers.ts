import { Controller } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { FilmAdminService } from "../shared/film-admin.service";
import { FilmCmsAccess } from "../shared/film-cms.decorators";
import { FilmCrudController } from "../shared/film-crud.controller";

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
  constructor(s: FilmAdminService) {
    super(s);
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

export const FILM_CONTENT_ADMIN_CONTROLLERS = [
  FilmItemsAdminController,
  FilmBannersAdminController,
  FilmAdvertisementsAdminController,
  FilmNotificationsAdminController,
  FilmSettingsAdminController,
  FilmReportsAdminController,
  FilmUploadsAdminController,
];
