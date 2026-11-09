import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class FilmAdminPaginationQueryDto {
  @ApiPropertyOptional({ description: "Page number, starting from 1", default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: "Number of records per page", default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({ description: "Filter by episode UUID" })
  @IsOptional()
  @IsString()
  episodeId?: string;

  @ApiPropertyOptional({ description: "Filter by movie UUID" })
  @IsOptional()
  @IsString()
  movieId?: string;

  @ApiPropertyOptional({ description: "Filter by status" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "Filter deleted state: 'true' (trash only), 'false' (active only), 'all'", default: "false" })
  @IsOptional()
  @IsString()
  deleted?: string;

  @ApiPropertyOptional({ description: "Filter by position (e.g. for banners: POPUP, HOME_HERO...)" })
  @IsOptional()
  @IsString()
  position?: string;

  @ApiPropertyOptional({ description: "Search movies by title or slug" })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: "Filter movies by release year" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;

  @ApiPropertyOptional({ description: "Filter movies by genre UUID" })
  @IsOptional()
  @IsString()
  genreId?: string;

  @ApiPropertyOptional({ description: "Filter movies by HOT flag ('true' or 'false')" })
  @IsOptional()
  @IsString()
  isHot?: string;

  @ApiPropertyOptional({ description: "Filter movies by recommended flag ('true' or 'false')" })
  @IsOptional()
  @IsString()
  isRecommended?: string;

  @ApiPropertyOptional({ description: "Filter users by role (ADMIN, USER, GUEST, VIP, MODERATOR)" })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ description: "Filter reports by reason" })
  @IsOptional()
  @IsString()
  reason?: string;
}
