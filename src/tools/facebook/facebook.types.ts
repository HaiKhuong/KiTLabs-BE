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
  body: string;
  enabled: boolean;
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
  @IsBoolean()
  affiliateEnabled = true;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsBoolean()
  publish!: boolean;
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
  @IsBoolean()
  affiliateEnabled?: boolean;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;

  @IsOptional()
  @IsBoolean()
  publish?: boolean;
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
