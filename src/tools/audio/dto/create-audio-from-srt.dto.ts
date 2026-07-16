import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
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

export class CreateAudioFromSrtDto {
  @ApiProperty({ description: "Owner user UUID" })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: "Full SRT content", maxLength: 500_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500_000)
  srtText!: string;

  @ApiProperty({ enum: ["preset", "clone"] })
  @IsIn(["preset", "clone"])
  voiceMode!: "preset" | "clone";

  @ApiPropertyOptional({ description: "Preset voice id when voiceMode=preset" })
  @ValidateIf((o: CreateAudioFromSrtDto) => o.voiceMode === "preset")
  @IsString()
  @IsNotEmpty()
  voiceId?: string;

  @ApiPropertyOptional({ description: "Clone ref under uploads/audio-clone/<userId>/" })
  @ValidateIf((o: CreateAudioFromSrtDto) => o.voiceMode === "clone" && !o.pipelineRefWav?.trim())
  @IsString()
  @IsNotEmpty()
  cloneRefWav?: string;

  @ApiPropertyOptional({ description: "Pipeline voice filename under voice/" })
  @ValidateIf((o: CreateAudioFromSrtDto) => o.voiceMode === "clone" && !o.cloneRefWav?.trim())
  @IsString()
  @IsNotEmpty()
  pipelineRefWav?: string;

  @ApiPropertyOptional({ description: "Transcript of clone reference (studio clone only)" })
  @ValidateIf(
    (o: CreateAudioFromSrtDto) => o.voiceMode === "clone" && !o.pipelineRefWav?.trim(),
  )
  @IsString()
  @IsNotEmpty()
  cloneRefText?: string;

  @ApiPropertyOptional({
    enum: ["omnivoice", "voxcpm2"],
    default: "omnivoice",
    description: "TTS engine: OmniVoice or VoxCPM2",
  })
  @IsOptional()
  @IsIn(["omnivoice", "voxcpm2"])
  ttsEngine?: "omnivoice" | "voxcpm2";

  @ApiPropertyOptional({ default: 1, minimum: 0.5, maximum: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(2)
  speed?: number;

  @ApiPropertyOptional({
    description: "If true, fit each cue speech into SRT window (atempo / pad)",
    default: true,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  fitToCue?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimatedCost?: number;
}
