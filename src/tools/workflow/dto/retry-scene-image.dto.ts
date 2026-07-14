import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class RetrySceneImageDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  nodeId!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  sceneNumber!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  negativePrompt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  style?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  aspectRatio?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  model?: string;
}
