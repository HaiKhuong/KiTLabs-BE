import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmCommentsQueryDto, FilmMovieBannersQueryDto, FilmMoviesQueryDto } from "../../dto/film-catalog.dto";
import { FilmCatalogService } from "./film-catalog.service";

@Public()
@ApiTags("Film Guest - Catalog")
@Controller("film")
export class FilmCatalogController {
  constructor(private readonly service: FilmCatalogService) {}

  @ApiOperation({ summary: "Get paginated movie catalog with search and filters" })
  @Get("movies")
  movies(@Query() query: FilmMoviesQueryDto) {
    return this.service.publicMovies(query);
  }

  @ApiOperation({ summary: "Get movie details and episodes by slug" })
  @ApiParam({ name: "slug", description: "Movie slug identifier" })
  @Get("movies/:slug")
  movie(@Param("slug") slug: string) {
    return this.service.movie(slug);
  }

  @ApiOperation({ summary: "Get movies for home hero banners" })
  @Get("banners/movies")
  movieBanners(@Query() query: FilmMovieBannersQueryDto) {
    return this.service.movieBanners(query);
  }

  @ApiOperation({ summary: "Get all genres sorted by name" })
  @Get("genres")
  genres() {
    return this.service.genres();
  }

  @ApiOperation({ summary: "Get all tags sorted by name" })
  @Get("tags")
  tags() {
    return this.service.tags();
  }

  @ApiOperation({ summary: "Get episode sources by episode ID" })
  @ApiParam({ name: "id", description: "Episode UUID" })
  @Get("episodes/:id/sources")
  sources(@Param("id") id: string) {
    return this.service.sources(id);
  }

  @ApiOperation({ summary: "Get active banners" })
  @Get("banners")
  banners() {
    return this.service.banners();
  }

  @ApiOperation({ summary: "Get active advertisements" })
  @Get("advertisements")
  advertisements() {
    return this.service.advertisements();
  }

  @ApiOperation({ summary: "Get film leaderboards" })
  @Get("leaderboards")
  leaderboards() {
    return this.service.leaderboards();
  }

  @ApiOperation({ summary: "Get approved comments for a movie" })
  @ApiParam({ name: "movieId", description: "Movie UUID" })
  @Get("movies/:movieId/comments")
  comments(@Param("movieId") movieId: string, @Query() query: FilmCommentsQueryDto) {
    return this.service.comments(movieId, query.cursor);
  }
}
