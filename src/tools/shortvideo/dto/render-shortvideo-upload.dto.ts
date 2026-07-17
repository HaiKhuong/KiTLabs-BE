import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";

/**
 * Multipart text fields that accompany the uploaded asset files
 * (background / left / right / voice) on POST tools/shortvideo/render-upload.
 */
export class RenderShortVideoUploadDto {
  @ApiProperty({ description: "Owner user UUID" })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ description: "Workflow node id (optional for standalone menu)" })
  @IsOptional()
  @IsString()
  nodeId?: string;

  @ApiPropertyOptional({ example: "ShortVideo — Internet vs WiFi" })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({
    description:
      "ShortVideo JSON spec as a string: { background, left:{title,image}, right:{title,image}, voice, scenes:[...] }. Uploaded files override background/left.image/right.image/voice.",
  })
  @IsString()
  @IsNotEmpty()
  spec!: string;

  @ApiPropertyOptional({ description: "Render config overrides as a JSON string" })
  @IsOptional()
  @IsString()
  engineConfig?: string;
}
