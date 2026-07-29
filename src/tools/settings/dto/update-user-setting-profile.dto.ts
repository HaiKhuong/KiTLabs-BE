import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, IsUrl } from "class-validator";

export class UpdateUserSettingProfileDto {
  @ApiProperty({ example: "user-uuid" })
  @IsString()
  userId!: string;

  @ApiProperty({ example: "Cố Nhân Quy", required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ example: "https://example.com/profile", required: false })
  @IsOptional()
  @IsUrl()
  directUrl?: string;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({
    example: true,
    required: false,
    description: "Re-enable a soft-disabled profile (true) or soft-disable (false)",
  })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
