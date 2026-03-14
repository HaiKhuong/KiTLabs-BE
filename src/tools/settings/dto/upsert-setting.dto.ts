import { IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class UpsertSettingDto {
  @ApiProperty({ example: "translate" })
  @IsString()
  type!: string;

  @ApiProperty({ example: "default_voice" })
  @IsString()
  code!: string;

  @ApiProperty({ example: "vi-VN-HoaiMyNeural" })
  @IsString()
  value!: string;
}
