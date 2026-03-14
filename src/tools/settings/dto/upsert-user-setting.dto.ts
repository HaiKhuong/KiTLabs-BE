import { IsOptional, IsString } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UpsertUserSettingDto {
  @ApiPropertyOptional({ example: "user-uuid" })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ example: "translate" })
  @IsString()
  type!: string;

  @ApiProperty({ example: "subtitle_font" })
  @IsString()
  code!: string;

  @ApiProperty({ example: "Arial" })
  @IsString()
  value!: string;
}
