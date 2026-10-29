import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

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
