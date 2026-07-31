import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

import {
  MERGE_SLIDE_TRANSITIONS,
  type MergeSlideTransition,
} from "../whiteboard-merge.service";

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
}
