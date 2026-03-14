import { IsOptional, IsString } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class UploadFileDto {
  @ApiPropertyOptional({ example: "videos" })
  @IsOptional()
  @IsString()
  folder?: string;
}
