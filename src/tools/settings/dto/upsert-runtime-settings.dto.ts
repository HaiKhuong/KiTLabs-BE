import { IsArray, IsString, ValidateNested } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";

export class UpsertRuntimeSettingItemDto {
  @ApiProperty()
  @IsString()
  code!: string;

  @ApiProperty()
  @IsString()
  value!: string;
}

export class UpsertRuntimeSettingsDto {
  @ApiProperty({ type: [UpsertRuntimeSettingItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpsertRuntimeSettingItemDto)
  items!: UpsertRuntimeSettingItemDto[];
}
