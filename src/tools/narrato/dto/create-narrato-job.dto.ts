import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";

export class NarratoEngineConfigDto {
  @ApiProperty()
  @IsString()
  localVideoPath!: string;

  @ApiPropertyOptional({ example: "film_summary", description: "film_summary | short" })
  @IsOptional()
  @IsString()
  mode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ example: "whisper", description: "upload | whisper" })
  @IsOptional()
  @IsString()
  subtitleSource?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  srtPath?: string;

  @ApiPropertyOptional({ example: "vi" })
  @IsOptional()
  @IsString()
  whisperLanguage?: string;

  @ApiPropertyOptional({ example: "Drama / emotion" })
  @IsOptional()
  @IsString()
  dramaGenre?: string;

  @ApiPropertyOptional({ example: "Vietnamese (Vietnam)" })
  @IsOptional()
  @IsString()
  narrationLanguage?: string;

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  originalSoundRatio?: number;

  @ApiPropertyOptional({ example: 500 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(5000)
  narrationWordCount?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  customClips?: number;

  @ApiPropertyOptional({ example: "omnivoice", description: "edge | omnivoice | voxcpm2" })
  @IsOptional()
  @IsString()
  ttsEngine?: string;

  @ApiPropertyOptional({ example: "vi-VN-HoaiMyNeural" })
  @IsOptional()
  @IsString()
  edgeTtsVoice?: string;

  @ApiPropertyOptional({ example: "+0%" })
  @IsOptional()
  @IsString()
  edgeTtsRate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-50)
  @Max(100)
  edgeTtsRatePercent?: number;

  @ApiPropertyOptional({
    description: "Reference wav/mp3 filename under tools/video-pipeline/voice/ (OmniVoice / VoxCPM2)",
  })
  @IsOptional()
  @IsString()
  omnivoiceRefWav?: string;

  @ApiPropertyOptional({
    description: "Transcript matching omnivoiceRefWav (OmniVoice / VoxCPM2)",
  })
  @IsOptional()
  @IsString()
  omnivoiceRefText?: string;

  @ApiPropertyOptional({
    example: "vietnamese",
    description: "Language for OmniVoice / VoxCPM2: vietnamese | english | korean | japanese",
  })
  @IsOptional()
  @IsString()
  omnivoiceLanguage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  geminiModel?: string;

  @ApiPropertyOptional({ example: "vip" })
  @IsOptional()
  @IsString()
  geminiKeyTier?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  workDirSlug?: string;
}

export class RunNarratoStepDto {
  @ApiProperty({ example: "ingest" })
  @IsString()
  step!: string;
}

export class CreateNarratoJobDto {
  @ApiProperty()
  @IsString()
  userId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({ type: NarratoEngineConfigDto })
  @ValidateNested()
  @Type(() => NarratoEngineConfigDto)
  engineConfig!: NarratoEngineConfigDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  estimatedCost?: number;
}

export class UpdateNarratoScriptDto {
  @ApiProperty()
  @IsObject()
  scriptPayload!: Record<string, unknown>;
}

export class UpdateNarratoTextDto {
  @ApiProperty()
  @IsString()
  text!: string;
}
