import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

import { AUDIO_MAX_TEXT_CHARS } from "../audio.constants";

export class CreateAudioJobDto {
  @ApiProperty({ description: "Owner user UUID" })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: "Text to synthesize", maxLength: AUDIO_MAX_TEXT_CHARS })
  @IsString()
  @IsNotEmpty()
  @MaxLength(AUDIO_MAX_TEXT_CHARS)
  text!: string;

  @ApiProperty({ enum: ["preset", "clone"] })
  @IsIn(["preset", "clone"])
  voiceMode!: "preset" | "clone";

  @ApiPropertyOptional({ description: "Preset voice id when voiceMode=preset" })
  @ValidateIf((o: CreateAudioJobDto) => o.voiceMode === "preset")
  @IsString()
  @IsNotEmpty()
  voiceId?: string;

  @ApiPropertyOptional({
    description: "Clone ref wav filename under uploads/audio-clone/<userId>/",
  })
  @ValidateIf((o: CreateAudioJobDto) => o.voiceMode === "clone")
  @IsString()
  @IsNotEmpty()
  cloneRefWav?: string;

  @ApiPropertyOptional({ description: "Transcript of clone reference audio" })
  @ValidateIf((o: CreateAudioJobDto) => o.voiceMode === "clone")
  @IsString()
  @IsNotEmpty()
  cloneRefText?: string;

  @ApiPropertyOptional({ default: 1, minimum: 0.5, maximum: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(2)
  speed?: number;

  @ApiPropertyOptional({ default: 0, minimum: -5, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-5)
  @Max(5)
  pitch?: number;

  @ApiPropertyOptional({ description: "Credit cost estimate (0 = free / no deduction)", default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimatedCost?: number;
}
