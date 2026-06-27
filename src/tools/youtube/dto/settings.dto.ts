import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsNumber, Min, Max } from "class-validator";

export class UpdateYouTubeSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  geminiModel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  temperature?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  trendsRegion?: string;

  @ApiPropertyOptional({ description: "Analytics sync interval in hours" })
  @IsOptional()
  @IsNumber()
  @Min(1)
  analyticsSyncInterval?: number;

  @ApiPropertyOptional({ description: "Trends sync interval in hours" })
  @IsOptional()
  @IsNumber()
  @Min(1)
  trendsSyncInterval?: number;
}
