import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

export class GenerateStudioImageDto {
  @ApiProperty({ description: "Owner user UUID" })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: "Text prompt for image generation" })
  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @ApiPropertyOptional({ default: "9:16" })
  @IsOptional()
  @IsString()
  aspectRatio?: string;

  @ApiPropertyOptional({ default: "anime" })
  @IsOptional()
  @IsString()
  style?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  negativePrompt?: string;

  @ApiPropertyOptional({ default: "z-image-turbo" })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ description: "Inference steps (ComfyUI sampler)", default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  numInferenceSteps?: number;

  @ApiPropertyOptional({ description: "Random seed (optional)" })
  @IsOptional()
  @IsInt()
  seed?: number;
}
