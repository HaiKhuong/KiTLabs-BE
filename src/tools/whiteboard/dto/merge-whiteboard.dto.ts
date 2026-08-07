import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

import {
  MERGE_SLIDE_TRANSITIONS,
  type MergeSlideTransition,
} from "../whiteboard-merge.service";

export class MergeSummaryFrameDto {
  @ApiProperty({ description: "Scene label shown in the frame" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label!: string;

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  x!: number;

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  y!: number;

  @ApiProperty({ minimum: 16 })
  @IsNumber()
  @Min(16)
  width!: number;

  @ApiProperty({ minimum: 9 })
  @IsNumber()
  @Min(9)
  height!: number;
}

export class MergeSummaryDto {
  @ApiProperty({ description: "Whether to append a summary outro clip" })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ description: "Outro duration in seconds", default: 3 })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(30)
  durationSec?: number;

  @ApiPropertyOptional({
    description: "PNG data URL of the arranged summary layout (16:9 frames, no detail)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(8_000_000)
  imageDataUrl?: string;

  @ApiPropertyOptional({ type: [MergeSummaryFrameDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => MergeSummaryFrameDto)
  frames?: MergeSummaryFrameDto[];

  @ApiPropertyOptional({
    enum: MERGE_SLIDE_TRANSITIONS,
    description: "Transition into the summary clip",
  })
  @IsOptional()
  @IsIn([...MERGE_SLIDE_TRANSITIONS])
  transition?: MergeSlideTransition;
}

export class MergeWhiteboardDto {
  @ApiProperty({ description: "User ID (guest or authenticated)" })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({
    description: "Ordered whiteboard history ids (completed scene MP4s) to merge",
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(40)
  @IsString({ each: true })
  historyIds!: string[];

  @ApiProperty({
    description: "Slide transition between consecutive clips (length = historyIds.length - 1)",
    enum: MERGE_SLIDE_TRANSITIONS,
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(39)
  @IsIn([...MERGE_SLIDE_TRANSITIONS], { each: true })
  transitions!: MergeSlideTransition[];

  @ApiPropertyOptional({ description: "Display name for the merged job" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @ApiPropertyOptional({ type: MergeSummaryDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MergeSummaryDto)
  summary?: MergeSummaryDto;
}
