import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";

export class ExecuteAiTaskDto {
  @ApiPropertyOptional({ description: "User UUID" })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiProperty({ description: "Provider id", default: "openai", example: "openai" })
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @ApiProperty({ description: "Model id, e.g. gpt-2.5-flash", example: "gpt-2.5-flash" })
  @IsString()
  @IsNotEmpty()
  model!: string;

  @ApiProperty({
    description: "Gemini key pool — normal = GEMINI_API_KEY; vip = GEMINI_API_KEY_VIP",
    enum: ["normal", "vip"],
    default: "normal",
    example: "normal",
  })
  @IsString()
  @IsIn(["normal", "vip"])
  apiKeyTier: "normal" | "vip" = "normal";

  @ApiProperty({ description: "Prompt template; may contain {{script}}" })
  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @ApiPropertyOptional({ description: "Script input (text or JSON string)" })
  @IsOptional()
  @IsString()
  script?: string;
}
