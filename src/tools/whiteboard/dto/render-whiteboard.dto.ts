import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

import { WHITEBOARD_OBJECT_TYPES, WHITEBOARD_REVEAL_STYLES, WhiteboardObjectType, WhiteboardRevealStyle } from "../whiteboard-scene";

export class WhiteboardEngineConfigDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  fps?: number;

  @ApiPropertyOptional({ description: "Scale the whole animation to this length", minimum: 1, maximum: 600 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(600)
  durationSec?: number;

  @ApiPropertyOptional({ description: "Mask eraser diameter in px", minimum: 4, maximum: 400 })
  @IsOptional()
  @IsNumber()
  @Min(4)
  @Max(400)
  brushSize?: number;

  @ApiPropertyOptional({ description: "Brush travel speed in px/s", minimum: 20, maximum: 20000 })
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(20_000)
  brushSpeedPx?: number;
}

export class WhiteboardObjectDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id!: string;

  @ApiProperty({ enum: WHITEBOARD_OBJECT_TYPES })
  @IsIn(WHITEBOARD_OBJECT_TYPES as unknown as string[])
  type!: WhiteboardObjectType;

  @ApiProperty({ description: "[x1, y1, x2, y2] in source-image pixels", type: [Number] })
  @IsArray()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsNumber({}, { each: true })
  bbox!: number[];

  @ApiProperty({ description: "Reading order, 1-based" })
  @IsInt()
  @Min(1)
  order!: number;

  @ApiPropertyOptional({
    enum: WHITEBOARD_REVEAL_STYLES,
    description: "Reveal style: hand path (zigzag/…) or effect (zoom_in/fade_in/…)",
  })
  @IsOptional()
  @IsIn(WHITEBOARD_REVEAL_STYLES as unknown as string[])
  revealStyle?: WhiteboardRevealStyle;
}

export class RenderWhiteboardDto {
  @ApiProperty({ description: "User ID (guest or authenticated)" })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({ description: "Id returned by POST /analyze" })
  @IsString()
  @IsNotEmpty()
  analysisId!: string;

  @ApiPropertyOptional({ description: "Human-readable name for this job" })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({
    description: "Manually drawn boxes in reading order",
    type: [WhiteboardObjectDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WhiteboardObjectDto)
  objects!: WhiteboardObjectDto[];

  @ApiPropertyOptional({ type: WhiteboardEngineConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WhiteboardEngineConfigDto)
  engineConfig?: WhiteboardEngineConfigDto;
}
