import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

import { WHITEBOARD_OBJECT_TYPES, WHITEBOARD_REVEAL_STYLES, WhiteboardObjectType, WhiteboardRevealStyle } from "../whiteboard-scene";

export class WhiteboardVoiceConfigDto {
  @ApiProperty({ enum: ["preset", "clone"] })
  @IsIn(["preset", "clone"])
  voiceMode!: "preset" | "clone";

  @ApiPropertyOptional({ description: "Preset voice id when voiceMode=preset" })
  @IsOptional()
  @IsString()
  voiceId?: string;

  @ApiPropertyOptional({ description: "Clone wav fileName when voiceMode=clone" })
  @IsOptional()
  @IsString()
  pipelineRefWav?: string;

  @ApiPropertyOptional({ description: "Clone reference text" })
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  cloneRefText?: string;

  @ApiPropertyOptional({ enum: ["omnivoice", "voxcpm2"], default: "omnivoice" })
  @IsOptional()
  @IsIn(["omnivoice", "voxcpm2"])
  ttsEngine?: "omnivoice" | "voxcpm2";

  @ApiPropertyOptional({ minimum: 0.5, maximum: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(2)
  speed?: number;
}

export class WhiteboardEngineStoryboardDto {
  @ApiProperty({ description: "0-based storyboard index within the scene", minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(200)
  index!: number;

  @ApiProperty({ description: "Narration text for TTS" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000)
  voice!: string;
}

export class WhiteboardCameraZoomGroupDto {
  @ApiProperty({
    description: "0-based storyboard indices sharing one zoom shot",
    type: [Number],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(200, { each: true })
  storyboardIndices!: number[];
}

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

  @ApiPropertyOptional({
    description: "OmniVoice config used when objects carry storyboard.voice",
    type: WhiteboardVoiceConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WhiteboardVoiceConfigDto)
  voice?: WhiteboardVoiceConfigDto;

  @ApiPropertyOptional({
    description: "Full scene storyboard list for voice-led TTS (independent of layer bindings)",
    type: [WhiteboardEngineStoryboardDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => WhiteboardEngineStoryboardDto)
  storyboards?: WhiteboardEngineStoryboardDto[];

  @ApiPropertyOptional({
    description: "Use the user-uploaded custom hand image when available",
  })
  @IsOptional()
  @IsBoolean()
  useCustomHand?: boolean;

  @ApiPropertyOptional({
    description: "Camera zoom groups by storyboard indices (16:9 crop around bound layers)",
    type: [WhiteboardCameraZoomGroupDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WhiteboardCameraZoomGroupDto)
  cameraZooms?: WhiteboardCameraZoomGroupDto[];

  @ApiPropertyOptional({
    description: "Recent-image ids used on this scene (copied into history for audit)",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  selectedRecentIds?: string[];
}

export class WhiteboardObjectStoryboardDto {
  @ApiProperty({ description: "0-based storyboard index within the scene", minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(200)
  index!: number;

  @ApiProperty({ description: "Narration spoken during this storyboard" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000)
  voice!: string;
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

  @ApiPropertyOptional({
    description: "Desired drawing duration for this object in seconds (hand styles)",
    minimum: 0.1,
    maximum: 60,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(60)
  durationSec?: number;

  @ApiPropertyOptional({
    description: "Sampled SVG paths as arrays of [x,y] points in source-image pixels",
    type: "array",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(256)
  strokePaths?: unknown[];

  @ApiPropertyOptional({
    description: "Storyboard binding from idea generation (index + voice)",
    type: WhiteboardObjectStoryboardDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WhiteboardObjectStoryboardDto)
  storyboard?: WhiteboardObjectStoryboardDto;
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
