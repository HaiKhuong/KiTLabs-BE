import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class FilmMoviesQueryDto {
  @ApiPropertyOptional({ description: "Page number, starting from 1", default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: "Number of items per page", default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: "Search query for movie title" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: "Filter hot movies" })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === "true" || value === true) return true;
    if (value === "false" || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  hot?: boolean;

  @ApiPropertyOptional({ description: "Filter recommended movies" })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === "true" || value === true) return true;
    if (value === "false" || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  recommended?: boolean;

  @ApiPropertyOptional({ description: "Filter by genre slug" })
  @IsOptional()
  @IsString()
  genre?: string;

  @ApiPropertyOptional({ description: "Sort by views, favorited, etc.", example: "views" })
  @IsOptional()
  @IsString()
  sort?: string;
}

export class FilmMovieBannersQueryDto {
  @ApiPropertyOptional({ description: "Number of banner movies to fetch", default: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    description: "Filter recommended movies ('true', 'false', 'all'). Defaults to 'true'",
    default: "true",
  })
  @IsOptional()
  @IsString()
  recommended?: string;
}

export class FilmCommentsQueryDto {
  @ApiPropertyOptional({ description: "Cursor timestamp for pagination" })
  @IsOptional()
  @IsString()
  cursor?: string;
}

