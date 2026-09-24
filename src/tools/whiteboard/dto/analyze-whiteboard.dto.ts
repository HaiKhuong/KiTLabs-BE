import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";

export class AnalyzeWhiteboardDto {
  @ApiProperty({ description: "User ID (guest or authenticated)" })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiPropertyOptional({ description: "Workflow node id for socket correlation" })
  @IsOptional()
  @IsString()
  nodeId?: string;

  @ApiPropertyOptional({ description: "Human-readable name for this job" })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional({ description: "whiteboard_idea_histories id — reuse prior scene history when re-rendering" })
  @IsOptional()
  @IsString()
  ideaHistoryId?: string;

  @ApiPropertyOptional({ description: "0-based scene index within the idea/project" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sceneIndex?: number;
}
