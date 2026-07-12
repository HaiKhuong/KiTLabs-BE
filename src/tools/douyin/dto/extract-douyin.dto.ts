import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUrl } from "class-validator";

export class ExtractDouyinDto {
  @ApiProperty({ description: "Douyin video URL", example: "https://www.douyin.com/video/123456" })
  @IsString()
  @IsUrl()
  url!: string;

  @ApiPropertyOptional({ description: "Cookies content in Netscape format" })
  @IsOptional()
  @IsString()
  cookieContent?: string;
}
