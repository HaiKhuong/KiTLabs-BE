import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";

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
}
