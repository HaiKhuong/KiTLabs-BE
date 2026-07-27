import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";

export class RenameWorkflowDto {
  @ApiProperty({ description: "User UUID" })
  @IsUUID()
  userId!: string;

  @ApiProperty({ description: "New profile key / slug", example: "my-pipeline" })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    description: "Optional display name to write into document.name",
  })
  @IsOptional()
  @IsString()
  displayName?: string;
}
