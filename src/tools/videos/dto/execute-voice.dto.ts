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
  Min,
  ValidateIf,
} from "class-validator";

export class ExecuteVoiceDto {
  @ApiProperty({ description: "Owner user UUID" })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: "Scene JSON (SceneReviewPayload) or scenes array" })
  @IsString()
  @IsNotEmpty()
  scenes!: string;

  @ApiProperty({ enum: ["preset", "clone"] })
  @IsIn(["preset", "clone"])
  voiceMode!: "preset" | "clone";

  @ApiPropertyOptional({ description: "Preset voice id when voiceMode=preset" })
  @ValidateIf((o: ExecuteVoiceDto) => o.voiceMode === "preset")
  @IsString()
  @IsNotEmpty()
  voiceId?: string;

  @ApiPropertyOptional({ description: "Pipeline clone wav filename when voiceMode=clone" })
  @ValidateIf((o: ExecuteVoiceDto) => o.voiceMode === "clone")
  @IsString()
  @IsNotEmpty()
  pipelineRefWav?: string;

  @ApiPropertyOptional({ description: "Clone reference transcript (pipeline voices)" })
  @IsOptional()
  @IsString()
  cloneRefText?: string;

  @ApiPropertyOptional({ default: 1, minimum: 0.5, maximum: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(2)
  speed?: number;

  @ApiPropertyOptional({
    description: "Scenes per TTS batch (1–10). Default from VIDEOS_VOICE_BATCH_SIZE env.",
    default: 5,
    minimum: 1,
    maximum: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(10)
  batchSize?: number;
}
