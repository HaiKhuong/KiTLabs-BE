import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from "class-validator";

export class WorkflowRunNodeSummaryDto {
  @ApiProperty()
  @IsString()
  nodeId!: string;

  @ApiProperty()
  @IsString()
  label!: string;

  @ApiProperty()
  @IsString()
  nodeType!: string;

  @ApiProperty()
  @IsString()
  status!: string;
}

export class CreateWorkflowRunDto {
  @ApiProperty({ description: "User UUID" })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: "Workflow profile UUID" })
  @IsUUID()
  workflowId!: string;

  @ApiProperty({ enum: ["completed", "partial", "failed"] })
  @IsString()
  @IsIn(["completed", "partial", "failed"])
  status!: "completed" | "partial" | "failed";

  @ApiProperty({ description: "Full WorkflowDocument snapshot" })
  @IsObject()
  @IsNotEmpty()
  snapshot!: Record<string, unknown>;

  @ApiProperty({
    description: "Compact node summary for list UI",
    type: [WorkflowRunNodeSummaryDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowRunNodeSummaryDto)
  summary!: WorkflowRunNodeSummaryDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  errorMessage?: string;

  @ApiPropertyOptional({ description: "ISO start time" })
  @IsOptional()
  @IsString()
  startedAt?: string;

  @ApiPropertyOptional({ description: "ISO finish time" })
  @IsOptional()
  @IsString()
  finishedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  durationMs?: number;
}
