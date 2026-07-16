import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export class RecapEngineConfigDto {
  @ApiProperty({ description: "Absolute or workspace-relative path to source video" })
  @IsString()
  localVideoPath!: string;

  @ApiPropertyOptional({ example: "Movie Title" })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ example: 2024 })
  @IsOptional()
  @IsInt()
  year?: number;

  @ApiPropertyOptional({ description: "Target recap duration min seconds", example: 900 })
  @IsOptional()
  @IsInt()
  @Min(300)
  @Max(1800)
  durationMinSec?: number;

  @ApiPropertyOptional({ description: "Target recap duration max seconds", example: 1200 })
  @IsOptional()
  @IsInt()
  @Min(300)
  @Max(1800)
  durationMaxSec?: number;

  @ApiPropertyOptional({ example: 140 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(180)
  wordsPerMinute?: number;

  @ApiPropertyOptional({ example: "vi" })
  @IsOptional()
  @IsString()
  locale?: string;

  @ApiPropertyOptional({ example: "edge", description: "edge | omnivoice" })
  @IsOptional()
  @IsString()
  ttsEngine?: string;

  @ApiPropertyOptional({ example: "vi-VN-HoaiMyNeural" })
  @IsOptional()
  @IsString()
  edgeTtsVoice?: string;

  @ApiPropertyOptional({ description: "Gemini model override" })
  @IsOptional()
  @IsString()
  geminiModel?: string;

  @ApiPropertyOptional({ description: "normal | vip" })
  @IsOptional()
  @IsString()
  geminiKeyTier?: string;
}

export class CreateRecapJobDto {
  @ApiProperty({ example: "user-uuid" })
  @IsString()
  userId!: string;

  @ApiPropertyOptional({ description: "YouTube Kho phim movie id" })
  @IsOptional()
  @IsUUID()
  movieId?: string;

  @ApiPropertyOptional({ example: "Recap — Movie Name" })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({ type: RecapEngineConfigDto })
  @ValidateNested()
  @Type(() => RecapEngineConfigDto)
  engineConfig!: RecapEngineConfigDto;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  estimatedCost?: number;
}

export class UpdateRecapScriptDto {
  @ApiProperty({ description: "Lean script payload { t, d, n, r, m }" })
  @IsObject()
  scriptPayload!: Record<string, unknown>;
}
