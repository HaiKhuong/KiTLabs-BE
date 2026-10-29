import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from "class-validator";

export class CreateFilmReportDto {
  @ApiProperty({ description: "Movie UUID", example: "b2d3c4e5-f6a7-8901-bcde-f123456789ab" })
  @IsNotEmpty()
  @IsUUID()
  movieId!: string;

  @ApiPropertyOptional({ description: "Episode UUID" })
  @IsOptional()
  @IsUUID()
  episodeId?: string;

  @ApiPropertyOptional({ description: "Episode Number", example: 1 })
  @IsOptional()
  @IsNumber()
  episodeNumber?: number;

  @ApiPropertyOptional({ description: "Episode Title", example: "Phần 1" })
  @IsOptional()
  @IsString()
  episodeTitle?: string;

  @ApiPropertyOptional({ description: "Current page URL", example: "https://kitlabs.space/phim/tay-du-ky" })
  @IsOptional()
  @IsString()
  pageUrl?: string;

  @ApiPropertyOptional({ description: "Reason for reporting", example: "VIDEO_NOT_PLAYING" })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({ description: "Detailed description of the issue" })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: "Device ID / Fingerprint" })
  @IsOptional()
  @IsString()
  deviceId?: string;
}

