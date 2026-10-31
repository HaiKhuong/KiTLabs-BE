import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateAuditLogDto {
  @ApiProperty({ description: "Module name: film, admin, tools_web, tools_app", example: "film" })
  @IsString()
  @IsNotEmpty()
  module!: string;

  @ApiProperty({ description: "Session ID (unique per tab/reload)", example: "sess_123456" })
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @ApiProperty({
    description: "Event name: load_page, search, play_movie, comment, change_avt, change_name, share, report, favorites",
    example: "play_movie",
  })
  @IsString()
  @IsNotEmpty()
  event!: string;

  @ApiPropertyOptional({ description: "Object ID (movie UUID, episode UUID, comment UUID, etc.)" })
  @IsOptional()
  @IsString()
  objectId?: string;

  @ApiPropertyOptional({ description: "Object Name (Movie title, episode title, keyword, etc.)" })
  @IsOptional()
  @IsString()
  objectName?: string;

  @ApiPropertyOptional({ description: "Object Type (movie, episode, comment, profile, etc.)" })
  @IsOptional()
  @IsString()
  objectType?: string;

  @ApiPropertyOptional({ description: "Error code if operation failed" })
  @IsOptional()
  @IsString()
  errorCode?: string;

  @ApiPropertyOptional({ description: "Error message details" })
  @IsOptional()
  @IsString()
  errorMessage?: string;

  @ApiPropertyOptional({ description: "Current page route or URL", example: "/phim/dau-pha-thuong-khung" })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({ description: "User ID if available" })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: "Device ID if available" })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ description: "Custom metadata payload" })
  @IsOptional()
  metadata?: Record<string, any>;
}

