import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches } from "class-validator";

export class YtdlpDownloadDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/^https?:\/\//i, { message: "url must start with http(s)" })
  url!: string;

  @ApiPropertyOptional({ enum: ["video", "audio"], default: "video" })
  @IsOptional()
  @IsIn(["video", "audio"])
  format?: "video" | "audio";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  formatId?: string;
}
