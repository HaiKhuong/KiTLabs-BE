import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUrl } from "class-validator";

export class DownloadDouyinDto {
  @ApiProperty({ description: "Douyin video URL" })
  @IsString()
  @IsUrl()
  url!: string;

  @ApiPropertyOptional({ description: "yt-dlp format_id to download" })
  @IsOptional()
  @IsString()
  formatId?: string;

  @ApiPropertyOptional({ description: "Direct CDN video URL (Playwright profile formats)" })
  @IsOptional()
  @IsString()
  directUrl?: string;
}
