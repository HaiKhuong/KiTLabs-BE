import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";

export class ExecuteAiTaskDto {
  @ApiPropertyOptional({ description: "User UUID" })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: "Provider id", default: "openai" })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiProperty({ description: "Model id, e.g. gpt-2.5-flash" })
  @IsString()
  @IsNotEmpty()
  model!: string;

  @ApiProperty({ description: "Prompt template; may contain {{script}}" })
  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @ApiPropertyOptional({ description: "Script input (text or JSON string)" })
  @IsOptional()
  @IsString()
  script?: string;
}
