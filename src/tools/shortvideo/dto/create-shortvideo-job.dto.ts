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
      "ShortVideo JSON spec as a string: { background, left:{title,image}, right:{title,image}, voice, scenes:[{start,end,dragonPose,subtitle,highlight,zoom}] }",
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
