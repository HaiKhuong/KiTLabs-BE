import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  IsNumber,
  ValidateIf,
  ValidateNested,
} from "class-validator";

import {
  FacebookAffiliateStatus,
  FacebookContentKind,
  FacebookPostStatus,
  FacebookSelectionRule,
} from "./facebook.enums";

export {
  FACEBOOK_PUBLISH_QUEUE,
  FACEBOOK_REQUIRED_SCOPES,
  FacebookAccountStatus,
  FacebookAffiliateStatus,
  FacebookContentKind,
  FacebookPageStatus,
  FacebookPostStatus,
  FacebookSelectionRule,
  FacebookTaskKind,
  FacebookTaskOutcome,
  FacebookUploadPhase,
} from "./facebook.enums";

export type CommentTemplate = {
  id: string;
  name?: string;
  body: string;
  enabled: boolean;
};

export type MoviePlaylistTemplate = {
  id: string;
  name: string;
  body: string;
  enabled: boolean;
};

export type CrossPromoTemplate = {
  id: string;
  name: string;
  platform: "youtube" | "facebook";
  body: string;
  enabled: boolean;
};

export type FacebookVideoCommentAttempt = {
  type: "affiliate" | "movie_playlist" | "cross_promo";
  linkId?: string | null;
  message: string;
  commentId: string | null;
  status: "pending" | "done" | "uncertain" | "failed";
  errorCode: string | null;
  createdAt: string;
  updatedAt?: string;
};

export type FacebookCommentAttempt = {
  linkId: string;
  message: string;
  commentId: string | null;
  status: "pending" | "done" | "uncertain" | "failed";
  errorCode: string | null;
};

export class CreateFacebookPostDto {
  @IsUUID()
  pageId!: string;

  @IsEnum(FacebookContentKind)
  kind!: FacebookContentKind;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  message?: string;

  @IsOptional()
  @IsString()
  sourcePath?: string;

  @IsOptional()
  @IsString()
  thumbnailPath?: string;

  @IsOptional()
  @IsBoolean()
  affiliateEnabled = true;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsBoolean()
  publish!: boolean;

  @IsOptional()
  @IsBoolean()
  filmSyncEnabled?: boolean;

  @ValidateIf((dto: CreateFacebookPostDto) => dto.filmSyncEnabled === true)
  @IsUUID()
  filmMovieId?: string;

  @ValidateIf((dto: CreateFacebookPostDto) => dto.filmSyncEnabled === true)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  @Max(99999.9)
  filmEpisodeNumber?: number;
}

export class UpdateFacebookPostDto {
  @IsOptional()
  @IsUUID()
  pageId?: string;

  @IsOptional()
  @IsEnum(FacebookContentKind)
  kind?: FacebookContentKind;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  message?: string;

  @IsOptional()
  @IsString()
  sourcePath?: string;

  @IsOptional()
  @IsString()
  thumbnailPath?: string | null;

  @IsOptional()
  @IsBoolean()
  affiliateEnabled?: boolean;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;

  @IsOptional()
  @IsBoolean()
  publish?: boolean;

  @IsOptional()
  @IsBoolean()
  filmSyncEnabled?: boolean;

  @IsOptional()
  @IsUUID()
  filmMovieId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  @Max(99999.9)
  filmEpisodeNumber?: number | null;
}

export class FacebookPostQueryDto {
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
  @IsEnum(FacebookPostStatus)
  status?: FacebookPostStatus;

  @IsOptional()
  @IsEnum(FacebookContentKind)
  kind?: FacebookContentKind;

  @IsOptional()
  @IsUUID()
  pageId?: string;
}

export class UpsertAffiliateLinkDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(2000)
  affiliateUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  destinationUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  productGroup?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  pageIds?: string[];

  @IsOptional()
  @IsEnum(FacebookAffiliateStatus)
  status?: FacebookAffiliateStatus;

  @IsOptional()
  @IsISO8601()
  startsAt?: string | null;

  @IsOptional()
  @IsISO8601()
  endsAt?: string | null;
}

export class CommentTemplateDto {
  @IsString()
  @MaxLength(80)
  id!: string;

  @IsString()
  @MaxLength(2000)
  body!: string;

  @IsBoolean()
  enabled!: boolean;
}

export class SaveCommentSettingsDto {
  @IsBoolean()
  autoCommentVideo!: boolean;

  @IsBoolean()
  autoCommentPost!: boolean;

  @IsInt()
  @Min(1)
  @Max(10)
  commentCount!: number;

  @IsEnum(FacebookSelectionRule)
  selectionRule!: FacebookSelectionRule;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CommentTemplateDto)
  templates!: CommentTemplateDto[];
}

export class FacebookTaskQueryDto {
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
}

export class SyncFacebookVideosDto {
  @IsUUID()
  pageId!: string;
}

export class AssignVideoPlaylistDto {
  @IsOptional()
  @IsString()
  playlistId?: string | null;

  @IsOptional()
  @IsString()
  playlistTitle?: string | null;
}

export class MoviePlaylistTemplateDto {
  @IsString()
  @MaxLength(80)
  id!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(5000)
  body!: string;

  @IsBoolean()
  enabled!: boolean;
}

export class CrossPromoTemplateDto {
  @IsString()
  @MaxLength(80)
  id!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(20)
  platform!: "youtube" | "facebook";

  @IsString()
  @MaxLength(5000)
  body!: string;

  @IsBoolean()
  enabled!: boolean;
}

export class SavePageCommentSettingsDto {
  @IsUUID()
  pageId!: string;

  @IsEnum(FacebookSelectionRule)
  selectionRule!: FacebookSelectionRule;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CommentTemplateDto)
  affiliateTemplates!: CommentTemplateDto[];

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MoviePlaylistTemplateDto)
  moviePlaylistTemplates!: MoviePlaylistTemplateDto[];

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CrossPromoTemplateDto)
  crossPromoTemplates!: CrossPromoTemplateDto[];
}

export class CommentOnVideoDto {
  @IsString()
  type!: "affiliate" | "movie_playlist" | "cross_promo";

  @IsOptional()
  @IsString()
  templateId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  customMessage?: string;

  @IsOptional()
  @IsString()
  targetMovieTitle?: string;

  @IsOptional()
  @IsString()
  targetMovieUrl?: string;

  @IsOptional()
  @IsString()
  platform?: "youtube" | "facebook";

  @IsOptional()
  @IsBoolean()
  forceCreate?: boolean;
}

export class FacebookVideoQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  pageId?: string;

  @IsOptional()
  @IsString()
  playlistId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}

export class FacebookPlaylistQueryDto {
  @IsOptional()
  @IsString()
  pageId?: string;
}

export class CreatePlaylistDto {
  @IsString()
  pageId!: string;

  @IsString()
  @MaxLength(500)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;
}
