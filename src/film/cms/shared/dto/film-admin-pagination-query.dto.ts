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
}
