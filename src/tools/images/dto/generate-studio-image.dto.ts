import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export class StudioReferenceImageDto {
  @ApiProperty({ example: "image/png", enum: ["image/png", "image/jpeg", "image/webp"] })
  @IsString()
  @IsIn(["image/png", "image/jpeg", "image/webp"])
  mimeType!: "image/png" | "image/jpeg" | "image/webp";

  @ApiProperty({ description: "Raw base64 image data without data-URL prefix" })
  @IsString()
  @IsNotEmpty()
  @IsBase64()
  data!: string;
}

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

  @ApiPropertyOptional({ description: "Resolution quality: 720p or 1080p", default: "720p" })
  @IsOptional()
  @IsString()
  quality?: string;

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

  @ApiPropertyOptional({ enum: ["comfyui", "gflow"], default: "comfyui" })
  @IsOptional()
  @IsIn(["comfyui", "gflow"])
  provider?: "comfyui" | "gflow";

  @ApiPropertyOptional({ type: StudioReferenceImageDto, description: "Optional single reference image for GFlow i2i" })
  @IsOptional()
  @ValidateNested()
  @Type(() => StudioReferenceImageDto)
  referenceImage?: StudioReferenceImageDto;

  @ApiPropertyOptional({
    type: [StudioReferenceImageDto],
    maxItems: 10,
    description: "Optional multiple reference images for GFlow i2i (max 10)",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => StudioReferenceImageDto)
  referenceImages?: StudioReferenceImageDto[];
}
