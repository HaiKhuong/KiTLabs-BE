import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsOptional, IsString, ValidateNested } from "class-validator";

export class CompareSubtitleBlockDto {
  @ApiProperty({ example: "11" })
  @IsString()
  index!: string;

  @ApiProperty({ example: "00:00:19,133 --> 00:00:22,632" })
  @IsString()
  timestamp!: string;

  @ApiProperty({ example: "希望你们下一屆能喚醒一些強大的神灵" })
  @IsString()
  text!: string;
}

export class TranslateCompareSubtitleDto {
  @ApiProperty({ type: [CompareSubtitleBlockDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompareSubtitleBlockDto)
  blocks!: CompareSubtitleBlockDto[];

  @ApiPropertyOptional({
    description: "Custom translation context (same as pipeline translationContext).",
  })
  @IsOptional()
  @IsString()
  translationContext?: string;
}
