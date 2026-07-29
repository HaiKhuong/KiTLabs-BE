import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";

export const GEMINI_IMAGE_MODELS = [
  "gemini-3.1-flash-lite-image",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
] as const;

export const GEMINI_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9",
] as const;

export const GEMINI_IMAGE_SIZES = ["512", "1K", "2K", "4K"] as const;

export type GeminiImageModel = (typeof GEMINI_IMAGE_MODELS)[number];
export type GeminiImageAspectRatio = (typeof GEMINI_IMAGE_ASPECT_RATIOS)[number];
export type GeminiImageSize = (typeof GEMINI_IMAGE_SIZES)[number];

export class GenerateGeminiImageDto {
  @ApiProperty({ description: "Text prompt for Gemini image generation" })
  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @ApiPropertyOptional({
    enum: GEMINI_IMAGE_MODELS,
    default: "gemini-3.1-flash-image",
  })
  @IsOptional()
  @IsIn(GEMINI_IMAGE_MODELS)
  model?: GeminiImageModel;

  @ApiPropertyOptional({
    enum: GEMINI_IMAGE_ASPECT_RATIOS,
    default: "1:1",
  })
  @IsOptional()
  @IsIn(GEMINI_IMAGE_ASPECT_RATIOS)
  aspectRatio?: GeminiImageAspectRatio;

  @ApiPropertyOptional({
    enum: GEMINI_IMAGE_SIZES,
    default: "1K",
    description: "512 is only available for gemini-3.1-flash-image",
  })
  @IsOptional()
  @IsIn(GEMINI_IMAGE_SIZES)
  imageSize?: GeminiImageSize;

  @ApiPropertyOptional({
    default: false,
    description: "Ground generation with current Google Search results",
  })
  @IsOptional()
  @IsBoolean()
  useGoogleSearch?: boolean;

  @ApiPropertyOptional({
    enum: ["normal", "vip"],
    default: "normal",
    description: "Gemini API key pool",
  })
  @IsOptional()
  @IsIn(["normal", "vip"])
  apiKeyTier?: "normal" | "vip";
}
