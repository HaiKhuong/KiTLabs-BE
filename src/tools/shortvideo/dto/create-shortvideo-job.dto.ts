import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsObject, IsOptional, IsString, IsUUID } from "class-validator";

export class CreateShortVideoJobDto {
  @ApiProperty({ description: "Owner user UUID" })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: "Workflow node id (FE correlation)" })
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @ApiPropertyOptional({ example: "ShortVideo — Internet vs WiFi" })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({
    description:
      "ShortVideo JSON spec as a string: { background, left:{title,image}, right:{title,image}, voice, scenes:[{start,end|duration,dragonPose,focus:'none'|'left'|'right',transitionSound?}], captions:[{time,text}], voiceConfig?:{ generate:true, engine:'omnivoice'|'voxcpm2', mode:'preset'|'clone', voiceId?, pipelineRefWav?, language?, speed?, syncTimeline?:boolean, gapSec? }, transitionSound? }. Per-scene transitionSound is a named key (e.g. 'whoosh_fast') resolved to assets/sfx/<name>.<mp3|wav|m4a|ogg>; played at the scene start.",
  })
  @IsString()
  @IsNotEmpty()
  spec!: string;

  @ApiPropertyOptional({
    description:
      "Render config overrides: width, height, fps, bitrate, font, fontSize, safeMargin, dragonPosition, subtitlePosition, titlePosition",
  })
  @IsOptional()
  @IsObject()
  engineConfig?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: "Absolute/relative directory holding asset files referenced by the spec",
  })
  @IsOptional()
  @IsString()
  assetsDir?: string;
}
