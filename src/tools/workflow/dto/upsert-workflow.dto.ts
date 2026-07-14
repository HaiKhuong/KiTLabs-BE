import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsObject, IsOptional, IsString, IsUUID } from "class-validator";

export class UpsertWorkflowDto {
  @ApiProperty({ description: "User UUID" })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ description: "Workflow name", default: "default" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: "Full workflow document (nodes + edges)" })
  @IsObject()
  @IsNotEmpty()
  document!: Record<string, unknown>;

  @ApiProperty({ description: "Nodes export list (name + params)" })
  @IsObject()
  @IsNotEmpty()
  nodesExport!: Record<string, unknown>;

  @ApiPropertyOptional({ description: "Content hash from client" })
  @IsOptional()
  @IsString()
  contentHash?: string;
}
