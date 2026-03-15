import { IsOptional, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class UpsertUserSettingDto {
  @ApiProperty({ example: "user-uuid" })
  @IsString()
  userId!: string;

  @ApiProperty({ example: "translate" })
  @IsString()
  type!: string;

  @ApiProperty({ example: "profile-uuid", required: false })
  @IsOptional()
  @IsString()
  profileId?: string;

  @ApiProperty({ example: "subtitle_font" })
  @IsString()
  code!: string;

  @ApiProperty({ example: "Arial" })
  @IsString()
  value!: string;
}
