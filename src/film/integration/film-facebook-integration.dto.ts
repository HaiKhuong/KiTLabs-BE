import { Type } from "class-transformer";
import { IsEnum, IsInt, IsNumber, IsString, IsUUID, Max, Min } from "class-validator";

export enum FilmFacebookKind {
  VIDEO = "video",
  REEL = "reel",
}

export class FilmMovieSearchDto {
  @IsString()
  q = "";
}

export class SyncFacebookFilmDto {
  @IsUUID()
  facebookPostUuid!: string;

  @IsString()
  facebookObjectId!: string;

  @IsString()
  pageGraphId!: string;

  @IsEnum(FilmFacebookKind)
  kind!: FilmFacebookKind;

  @IsUUID()
  movieId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  @Max(99999.9)
  episodeNumber!: number;

  @IsString()
  title!: string;

  @IsString()
  permalink!: string;
}
