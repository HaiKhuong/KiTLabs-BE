import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { TranslateEngineConfigDto } from "./translate-engine-config.dto";

export class CreateTranslateJobDto {
  @ApiPropertyOptional({ example: "user-uuid" })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({
    type: [Number],
    example: [1, 2, 3, 4, 5, 6],
    description: "Continuous step range values from 1 to 6.",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(6, { each: true })
  stepNbr!: number[];

  @ApiPropertyOptional({
    description: "Optional translate command options mapped to python CLI flags.",
    type: "object",
    example: {
      localVideoPath: "D:/videos/input.mp4",
      edgeTtsVoice: "vi-VN-HoaiMyNeural",
      speedVideo: 1.1,
      subtitleFont: "Arial",
    },
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslateEngineConfigDto)
  engineConfig?: TranslateEngineConfigDto;

  @ApiPropertyOptional({ example: 1.5 })
  @IsOptional()
  @IsNumber()
  estimatedCost?: number;
}
