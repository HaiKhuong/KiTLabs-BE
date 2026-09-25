import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";

export enum TikTokAccountStatus {
  CONNECTED = "connected",
  EXPIRED = "expired",
  REVOKED = "revoked",
}

export enum TikTokVideoStatus {
  IMPORTED = "imported",
  QUEUED = "queued",
  UPLOADING = "uploading",
  PROCESSING = "processing",
  PUBLISHED = "published",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum CommercialDisclosure {
  NONE = "NONE",
  ORGANIC_BRAND = "ORGANIC_BRAND",
  BRANDED_CONTENT = "BRANDED_CONTENT",
  BOTH = "BOTH",
}

export class ImportLocalVideoDto {
  @IsString()
  sourcePath!: string;
}

export class PublishTikTokVideoDto {
  @IsUUID()
  accountId!: string;

  @IsString()
  @MaxLength(2200)
  caption!: string;

  @IsString()
  privacyLevel!: string;

  @IsOptional()
  @IsBoolean()
  disableComment = true;

  @IsOptional()
  @IsBoolean()
  disableDuet = true;

  @IsOptional()
  @IsBoolean()
  disableStitch = true;

  @IsEnum(CommercialDisclosure)
  commercialDisclosure: CommercialDisclosure = CommercialDisclosure.NONE;

  @IsBoolean()
  musicUsageConfirmed!: boolean;

  @IsOptional()
  @IsBoolean()
  isAigc = false;
}

export class VideoHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @IsOptional()
  @IsEnum(TikTokVideoStatus)
  status?: TikTokVideoStatus;
}

export class TikTokVideoListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  maxCount = 20;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export type TikTokVideoMetadata = {
  format: string;
  codec: string;
  sizeBytes: number;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
};

export type ProviderDisclosure = {
  brand_organic_toggle: boolean;
  brand_content_toggle: boolean;
};

export function mapCommercialDisclosure(value: CommercialDisclosure): ProviderDisclosure {
  return {
    brand_organic_toggle: value === CommercialDisclosure.ORGANIC_BRAND || value === CommercialDisclosure.BOTH,
    brand_content_toggle: value === CommercialDisclosure.BRANDED_CONTENT || value === CommercialDisclosure.BOTH,
  };
}
