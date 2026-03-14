import { IsEnum, IsOptional, IsString } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { SourceType } from "../../../common/enums/domain.enums";

export class CreateDownloadDto {
  @ApiPropertyOptional({ example: "user-uuid" })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ enum: SourceType, example: SourceType.FILE })
  @IsEnum(SourceType)
  sourceType!: SourceType;

  @ApiProperty({ example: "D:/videos/input.mp4" })
  @IsString()
  sourceValue!: string;

  @ApiPropertyOptional({ example: "uploads/videos" })
  @IsOptional()
  @IsString()
  savePath?: string;
}
