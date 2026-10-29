import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class FilmCommentsQueryDto {
  @ApiPropertyOptional({ description: "Cursor timestamp for pagination" })
  @IsOptional()
  @IsString()
  cursor?: string;
}
