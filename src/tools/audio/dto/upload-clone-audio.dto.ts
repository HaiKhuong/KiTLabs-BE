import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class UploadCloneAudioQueryDto {
  @ApiPropertyOptional({ description: "Owner user UUID for grouping uploads" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;

  @ApiPropertyOptional({
    description: "Optional transcript of the reference clip (recommended for OmniVoice)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  refText?: string;
}
