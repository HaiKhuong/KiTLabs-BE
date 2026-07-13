import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, IsUrl, Max, Min } from "class-validator";
import { Type } from "class-transformer";

export class ExtractProfileDto {
  @ApiProperty({ description: "Douyin profile URL", example: "https://www.douyin.com/user/MS4wLjABAAAA..." })
  @IsString()
  @IsUrl()
  url!: string;

  @ApiPropertyOptional({ description: "Videos per page", default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  maxVideos?: number;

  @ApiPropertyOptional({ description: "Pagination cursor. Use 0 for first page, next_cursor for next page.", default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cursor?: number;
}
