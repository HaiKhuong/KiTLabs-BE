import { IsNumber, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class AdjustCreditDto {
  @ApiPropertyOptional({ example: "user-uuid" })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ example: -2.5 })
  @IsNumber()
  amount!: number;

  @ApiPropertyOptional({ example: "translate_video" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
