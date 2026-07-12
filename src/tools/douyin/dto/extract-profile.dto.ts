import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, IsUrl, Max, Min } from "class-validator";

export class ExtractProfileDto {
  @ApiProperty({ description: "Douyin profile URL", example: "https://www.douyin.com/user/MS4wLjABAAAA..." })
  @IsString()
  @IsUrl()
  url!: string;

  @ApiPropertyOptional({ description: "Cookies content in Netscape format" })
  @IsOptional()
  @IsString()
  cookieContent?: string;

  @ApiPropertyOptional({ description: "Max videos to fetch", default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxVideos?: number;
}
