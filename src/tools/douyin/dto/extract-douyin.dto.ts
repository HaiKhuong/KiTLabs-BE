import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, IsUrl } from "class-validator";

export class ExtractDouyinDto {
  @ApiProperty({
    description: "Douyin video URL (short or full)",
    example: "https://v.douyin.com/fPIVGeckUOg/",
  })
  @IsString()
  @IsUrl()
  url!: string;

  @ApiPropertyOptional({ enum: ["playwright", "ytdlp"] })
  @IsOptional()
  @IsIn(["playwright", "ytdlp"])
  provider?: "playwright" | "ytdlp";
}
