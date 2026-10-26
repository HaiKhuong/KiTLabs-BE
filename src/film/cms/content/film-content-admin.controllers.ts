import { Controller } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { FilmService } from "../../film.service";
import { FilmCmsAccess } from "../shared/film-cms.decorators";
import { FilmCrudController } from "../shared/film-crud.controller";

@FilmCmsAccess()
@ApiTags("Film CMS - Items")
@Controller("film/admin/items")
export class FilmItemsAdminController extends FilmCrudController {
  protected readonly resource = "items";
  constructor(s: FilmService) {
    super(s);
  }
}
@FilmCmsAccess()
@ApiTags("Film CMS - Banners")
@Controller("film/admin/banners")
export class FilmBannersAdminController extends FilmCrudController {
  protected readonly resource = "banners";
  constructor(s: FilmService) {
    super(s);
  }
}
@FilmCmsAccess()
@ApiTags("Film CMS - Advertisements")
@Controller("film/admin/advertisements")
export class FilmAdvertisementsAdminController extends FilmCrudController {
  protected readonly resource = "advertisements";
  constructor(s: FilmService) {
    super(s);
  }
}
@FilmCmsAccess()
@ApiTags("Film CMS - Notifications")
@Controller("film/admin/notifications")
export class FilmNotificationsAdminController extends FilmCrudController {
  protected readonly resource = "notifications";
  constructor(s: FilmService) {
    super(s);
  }
}

export const FILM_CONTENT_ADMIN_CONTROLLERS = [
  FilmItemsAdminController,
  FilmBannersAdminController,
  FilmAdvertisementsAdminController,
  FilmNotificationsAdminController,
];
