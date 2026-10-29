import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class FilmChatHistoryQueryDto {
  @ApiPropertyOptional({ description: "Chat room channel", default: "WORLD_GENERAL" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  room?: string;

  @ApiPropertyOptional({ description: "Cursor timestamp for chat pagination" })
  @IsOptional()
  @IsString()
  cursor?: string;
}

