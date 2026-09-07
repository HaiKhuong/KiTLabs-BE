import { IsArray, IsOptional, IsString } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class DownloadModelsDto {
  @ApiProperty({ type: [String], example: ["whisper-large-v3", "omnivoice", "qwen-vl-3b"] })
  @IsArray()
  @IsString({ each: true })
  ids!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;
}
