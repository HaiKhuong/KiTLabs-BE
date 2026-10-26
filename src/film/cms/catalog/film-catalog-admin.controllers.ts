import { Controller } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { FilmService } from "../../film.service";
import { FilmCmsAccess } from "../shared/film-cms.decorators";
import { FilmCrudController } from "../shared/film-crud.controller";

@FilmCmsAccess()
@ApiTags("Film CMS - Movies")
@Controller("film/admin/movies")
export class FilmMoviesAdminController extends FilmCrudController {
  protected readonly resource = "movies";
  constructor(s: FilmService) {
    super(s);
  }
}
@FilmCmsAccess()
@ApiTags("Film CMS - Genres")
@Controller("film/admin/genres")
export class FilmGenresAdminController extends FilmCrudController {
  protected readonly resource = "genres";
  constructor(s: FilmService) {
    super(s);
  }
}
@FilmCmsAccess()
@ApiTags("Film CMS - Tags")
@Controller("film/admin/tags")
export class FilmTagsAdminController extends FilmCrudController {
  protected readonly resource = "tags";
  constructor(s: FilmService) {
    super(s);
  }
}
@FilmCmsAccess()
@ApiTags("Film CMS - Episodes")
@Controller("film/admin/episodes")
export class FilmEpisodesAdminController extends FilmCrudController {
  protected readonly resource = "episodes";
  constructor(s: FilmService) {
    super(s);
  }
}
@FilmCmsAccess()
@ApiTags("Film CMS - Episode Sources")
@Controller("film/admin/episode-sources")
export class FilmEpisodeSourcesAdminController extends FilmCrudController {
  protected readonly resource = "episode-sources";
  constructor(s: FilmService) {
    super(s);
  }
}

export const FILM_CATALOG_ADMIN_CONTROLLERS = [
  FilmMoviesAdminController,
  FilmGenresAdminController,
  FilmTagsAdminController,
  FilmEpisodesAdminController,
  FilmEpisodeSourcesAdminController,
];
