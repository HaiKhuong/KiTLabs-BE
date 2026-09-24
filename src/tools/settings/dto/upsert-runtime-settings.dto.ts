import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";

export class UpsertRuntimeSettingItemDto {
  @ApiProperty()
  @IsString()
  code!: string;

  @ApiProperty()
  @IsString()
  value!: string;

  @ApiPropertyOptional({ description: "When true, delete a secret even if value is empty" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  clear?: boolean;
}

export class UpsertRuntimeSettingsDto {
  @ApiProperty({ type: [UpsertRuntimeSettingItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpsertRuntimeSettingItemDto)
  items!: UpsertRuntimeSettingItemDto[];
}
