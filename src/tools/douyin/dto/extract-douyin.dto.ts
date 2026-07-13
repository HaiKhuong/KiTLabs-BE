import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsUrl } from "class-validator";

export class ExtractDouyinDto {
  @ApiProperty({
    description: "Douyin video URL (short or full)",
    example: "https://v.douyin.com/fPIVGeckUOg/",
  })
  @IsString()
  @IsUrl()
  url!: string;
}
