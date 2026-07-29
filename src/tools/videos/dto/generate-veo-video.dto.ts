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
  IsUrl,
  IsUUID,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";

export const VEO_MODELS = [
  "veo-3.1-generate-preview",
  "veo-3.1-fast-generate-preview",
  "veo-3.1-lite-generate-preview",
] as const;

export type VeoModel = (typeof VEO_MODELS)[number];
export type VeoAspectRatio = "16:9" | "9:16";
export type VeoResolution = "720p" | "1080p" | "4k";
export type VeoPersonGeneration = "allow_all" | "allow_adult" | "dont_allow";

export class VeoInlineImageDto {
  @ApiProperty({ example: "image/png", enum: ["image/png", "image/jpeg", "image/webp"] })
  @IsString()
  @IsIn(["image/png", "image/jpeg", "image/webp"])
  mimeType!: "image/png" | "image/jpeg" | "image/webp";

  @ApiProperty({ description: "Raw base64 image data, without a data-URL prefix" })
  @IsString()
  @IsNotEmpty()
  @IsBase64()
  data!: string;
}

export class VeoReferenceImageDto extends VeoInlineImageDto {
  @ApiPropertyOptional({
    description: "Veo 3.1 currently supports asset references",
    enum: ["asset"],
    default: "asset",
  })
  @IsOptional()
  @IsIn(["asset"])
  referenceType?: "asset";
}

export class VeoInputVideoDto {
  @ApiProperty({ description: "URI returned by an earlier Veo generation" })
  @IsUrl({ require_protocol: true })
  uri!: string;

  @ApiPropertyOptional({ default: "video/mp4" })
  @IsOptional()
  @IsString()
  mimeType?: string;
}

export class GenerateVeoVideoDto {
  @ApiProperty({ description: "Owner user UUID" })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: "Video generation prompt (audio cues are supported)" })
  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @ApiPropertyOptional({ enum: VEO_MODELS, default: "veo-3.1-generate-preview" })
  @IsOptional()
  @IsIn(VEO_MODELS)
  model?: VeoModel;

  @ApiPropertyOptional({ enum: ["16:9", "9:16"], default: "16:9" })
  @IsOptional()
  @IsIn(["16:9", "9:16"])
  aspectRatio?: VeoAspectRatio;

  @ApiPropertyOptional({ enum: [4, 6, 8], default: 8 })
  @IsOptional()
  @IsInt()
  @IsIn([4, 6, 8])
  durationSeconds?: 4 | 6 | 8;

  @ApiPropertyOptional({ enum: ["720p", "1080p", "4k"], default: "720p" })
  @IsOptional()
  @IsIn(["720p", "1080p", "4k"])
  resolution?: VeoResolution;

  @ApiPropertyOptional({ enum: ["allow_all", "allow_adult", "dont_allow"] })
  @IsOptional()
  @IsIn(["allow_all", "allow_adult", "dont_allow"])
  personGeneration?: VeoPersonGeneration;

  @ApiPropertyOptional({
    description: "Improves repeatability but does not guarantee deterministic output",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  seed?: number;

  @ApiPropertyOptional({
    type: VeoInlineImageDto,
    description: "Initial image / first frame for image-to-video",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => VeoInlineImageDto)
  firstFrame?: VeoInlineImageDto;

  @ApiPropertyOptional({
    type: VeoInlineImageDto,
    description: "Final interpolation frame; requires firstFrame",
  })
  @ValidateIf((value: GenerateVeoVideoDto) => value.lastFrame != null)
  @ValidateNested()
  @Type(() => VeoInlineImageDto)
  lastFrame?: VeoInlineImageDto;

  @ApiPropertyOptional({
    type: [VeoReferenceImageDto],
    maxItems: 3,
    description: "Up to three subject/style reference images",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => VeoReferenceImageDto)
  referenceImages?: VeoReferenceImageDto[];

  @ApiPropertyOptional({
    type: VeoInputVideoDto,
    description: "A previous Veo result to extend",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => VeoInputVideoDto)
  extendVideo?: VeoInputVideoDto;

  @ApiPropertyOptional({
    enum: ["normal", "vip"],
    default: "normal",
    description: "Gemini API key pool",
  })
  @IsOptional()
  @IsIn(["normal", "vip"])
  apiKeyTier?: "normal" | "vip";
}
