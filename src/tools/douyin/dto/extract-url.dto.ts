import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUrl, Max, Min } from "class-validator";

export class ExtractUrlDto {
  @ApiProperty({
    description: "Douyin video or profile URL",
    example: "https://v.douyin.com/fPIVGeckUOg/",
  })
  @IsString()
  @IsUrl()
  url!: string;

  @ApiPropertyOptional({ description: "Videos per page when URL is a profile", default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  maxVideos?: number;

  @ApiPropertyOptional({
    description: "Profile pagination cursor. Use 0 for first page.",
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cursor?: number;
}
