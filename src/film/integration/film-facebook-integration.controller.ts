import { Body, Controller, Get, Headers, Post, Query, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import { Public } from "../../common/decorators/public.decorator";
import { FilmMovieSearchDto, SyncFacebookFilmDto } from "./film-facebook-integration.dto";
import { FilmFacebookIntegrationService } from "./film-facebook-integration.service";

@Public()
@Controller("film/integrations/facebook")
export class FilmFacebookIntegrationController {
  constructor(private readonly service: FilmFacebookIntegrationService) {}

  @Get("movies")
  movies(@Headers("x-film-integration-key") key: string | undefined, @Query() query: FilmMovieSearchDto) {
    this.authorize(key);
    return this.service.searchMovies(query.q);
  }

  @Post("sync")
  sync(@Headers("x-film-integration-key") key: string | undefined, @Body() dto: SyncFacebookFilmDto) {
    this.authorize(key);
    return this.service.syncFacebookPost(dto);
  }

  private authorize(candidate?: string): void {
    const expected = process.env.INTEGRATION_SERVICE_KEY?.trim();
    if (!expected || !candidate) throw new UnauthorizedException("Film integration is not configured");
    const left = Buffer.from(candidate);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new UnauthorizedException("Invalid film integration key");
    }
  }
}
