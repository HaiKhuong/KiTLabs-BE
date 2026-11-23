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
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";

export const VEO_MODELS = [
  "veo-3.1-generate-preview",
  "veo-3.1-fast-generate-preview",
  "veo-3.1-lite-generate-preview",
] as const;

export const GFLOW_VIDEO_MODELS = [
  "omni-flash",
  "omni-1.2-flash",
  "omni-1.2",
  "veo-lite",
  "veo-fast",
  "veo-quality",
] as const;
export const MUSE_VIDEO_MODELS = ["muse-agent"] as const;
export const ALL_VIDEO_MODELS = [...VEO_MODELS, ...GFLOW_VIDEO_MODELS, ...MUSE_VIDEO_MODELS] as const;

export type VeoModel = (typeof VEO_MODELS)[number];
export type GFlowVideoModel = (typeof GFLOW_VIDEO_MODELS)[number];
export type VideoModel = (typeof ALL_VIDEO_MODELS)[number];
export type VeoAspectRatio = "16:9" | "9:16" | "1:1";
export type VeoResolution = "360p" | "720p" | "1080p" | "4k";
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

  @ApiPropertyOptional({ enum: ALL_VIDEO_MODELS, default: "veo-3.1-generate-preview" })
  @IsOptional()
  @IsIn(ALL_VIDEO_MODELS)
  model?: VideoModel;

  @ApiPropertyOptional({ enum: ["16:9", "9:16", "1:1"], default: "16:9" })
  @IsOptional()
  @IsIn(["16:9", "9:16", "1:1"])
  aspectRatio?: VeoAspectRatio;

  @ApiPropertyOptional({ default: 8 })
  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(15)
  durationSeconds?: number;

  @ApiPropertyOptional({ enum: ["360p", "720p", "1080p", "4k"], default: "720p" })
  @IsOptional()
  @IsIn(["360p", "720p", "1080p", "4k"])
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
    maxItems: 7,
    description: "Up to 7 subject/style reference images (GFlow Omni Flash max=7, Veo=3)",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
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

  @ApiPropertyOptional({ enum: ["veo-api", "gflow", "muse"], default: "veo-api" })
  @IsOptional()
  @IsIn(["veo-api", "gflow", "muse"])
  provider?: "veo-api" | "gflow" | "muse";

  @ApiPropertyOptional({ description: "Optional voice name for GFlow video generation" })
  @IsOptional()
  @IsString()
  voice?: string;
}
