import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsObject, IsOptional, IsString, MaxLength } from "class-validator";

export class ActivityDto {
  @ApiProperty({ description: "Action name", maxLength: 100 })
  @IsString()
  @MaxLength(100)
  action!: string;

  @ApiPropertyOptional({ description: "Target entity type", maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetType?: string;

  @ApiPropertyOptional({ description: "Target entity ID", maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  targetId?: string;

  @ApiPropertyOptional({ description: "Activity payload" })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({ description: "Current page URL", maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  page?: string;

  @ApiPropertyOptional({ description: "Referrer URL", maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  referrer?: string;
}
