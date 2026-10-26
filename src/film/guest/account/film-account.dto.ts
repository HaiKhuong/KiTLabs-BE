import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import { ReactionType } from "../../entities/film.entities";

export class WatchDto {
  @IsUUID() movieId!: string;
  @IsUUID() episodeId!: string;
  @IsInt() @Min(0) stoppedAtSeconds!: number;
  @IsInt() @Min(0) watchedMinutes!: number;
}
export class MovieDto {
  @IsUUID() movieId!: string;
}
export class RatingDto extends MovieDto {
  @IsInt() @Min(1) @Max(5) score!: number;
  @IsOptional() @IsString() @MaxLength(2000) review?: string;
}
export class CommentDto extends MovieDto {
  @IsOptional() @IsUUID() episodeId?: string;
  @IsOptional() @IsUUID() parentId?: string;
  @IsString() @MaxLength(5000) content!: string;
  @IsOptional() @IsBoolean() isSpoil?: boolean;
}
export class ReactionDto {
  @IsEnum(ReactionType) type!: ReactionType;
}
export class ActivityDto {
  @IsString() @MaxLength(100) action!: string;
  @IsOptional() @IsString() @MaxLength(100) targetType?: string;
  @IsOptional() @IsString() @MaxLength(150) targetId?: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(1000) page?: string;
  @IsOptional() @IsString() @MaxLength(1000) referrer?: string;
}
