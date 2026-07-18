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
      "ShortVideo JSON spec as a string: { background, left:{title,image}, right:{title,image}, voice, scenes:[{dragonPose,focus:'none'|'left'|'right',transitionSound?,captions:[{text}]}], voiceConfig?:{ generate:true, engine:'omnivoice'|'voxcpm2', mode:'preset'|'clone', voiceId?, pipelineRefWav?, language?, speed?, gapSec?, volume?:0..2 }, transitionSound? }. Captions live inside each scene (scenes[].captions). When voiceConfig.generate is true, each scene's captions are joined into one sentence and voiced as a single TTS segment (no mid-scene pauses); the scene's duration is then set to the measured speech length and its captions are spread across it by text length. Caption `time` and scene `duration`/`start`/`end` are ignored — timing is derived entirely from the generated voice. voiceConfig.volume is applied only to generated TTS voice, never uploaded/external voice. Per-scene transitionSound is a named key (e.g. 'whoosh_fast') resolved to assets/sfx/<name>.<mp3|wav|m4a|ogg>; played at the scene start.",
  })
  @IsString()
  @IsNotEmpty()
  spec!: string;

  @ApiPropertyOptional({
    description:
      "Render config overrides: width, height, fps, bitrate, font, fontSize, titleFontSize, subtitleFontSize, safeMargin, dragonPosition, subtitlePosition, titlePosition, subtitleStyle:'pop'|'fade'|'slide'|'none'",
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
