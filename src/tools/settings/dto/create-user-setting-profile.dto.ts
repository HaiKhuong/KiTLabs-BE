import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, IsUrl } from "class-validator";

export class CreateUserSettingProfileDto {
  @ApiProperty({ example: "user-uuid" })
  @IsString()
  userId!: string;

  @ApiProperty({ example: "translate" })
  @IsString()
  type!: string;

  @ApiProperty({ example: "Default" })
  @IsString()
  name!: string;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({ example: "https://example.com/profile", required: false })
  @IsOptional()
  @IsUrl()
  directUrl?: string;
}
