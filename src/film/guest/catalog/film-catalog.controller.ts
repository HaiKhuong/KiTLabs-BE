import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmService } from "../../film.service";

@Public()
@ApiTags("Film Guest - Catalog")
@Controller("film")
export class FilmCatalogController {
  constructor(private readonly service: FilmService) {}

  @Get("movies")
  movies(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
    @Query("hot") hot?: string,
    @Query("recommended") recommended?: string,
    @Query("genre") genre?: string,
    @Query("sort") sort?: string,
  ) {
    return this.service.publicMovies({
      page: Number(page),
      limit: Number(limit),
      search,
      hot: hot === undefined ? undefined : hot === "true",
      recommended: recommended === undefined ? undefined : recommended === "true",
      genre,
      sort,
    });
  }
  @Get("movies/:slug") movie(@Param("slug") slug: string) {
    return this.service.movie(slug);
  }
  @Get("banners/movies") movieBanners(@Query("limit") limit?: string) {
    return this.service.movieBanners(Number(limit));
  }
  @Get("genres") genres() {
    return this.service.genres();
  }
  @Get("tags") tags() {
    return this.service.tags();
  }
  @Get("episodes/:id/sources") sources(@Param("id") id: string) {
    return this.service.sources(id);
  }
  @Get("banners") banners() {
    return this.service.banners();
  }
  @Get("advertisements") advertisements() {
    return this.service.advertisements();
  }
  @Get("leaderboards") leaderboards() {
    return this.service.leaderboards();
  }
  @Get("movies/:movieId/comments") comments(@Param("movieId") movieId: string, @Query("cursor") cursor?: string) {
    return this.service.comments(movieId, cursor);
  }
}
