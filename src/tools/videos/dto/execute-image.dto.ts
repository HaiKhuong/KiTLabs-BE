import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";

export class ExecuteImageDto {
  @ApiProperty({ description: "Owner user UUID" })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: "Workflow node id (FE correlation)" })
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @ApiProperty({ description: "Scene JSON with imagePrompt per scene" })
  @IsString()
  @IsNotEmpty()
  scenes!: string;

  @ApiPropertyOptional({ default: "generate" })
  @IsOptional()
  @IsString()
  mode?: string;

  @ApiPropertyOptional({ default: "cinematic" })
  @IsOptional()
  @IsString()
  style?: string;

  @ApiPropertyOptional({ default: "9:16" })
  @IsOptional()
  @IsString()
  aspectRatio?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  model?: string;
}
