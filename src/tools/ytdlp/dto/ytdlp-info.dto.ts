import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches } from "class-validator";

export class YtdlpInfoDto {
  @ApiProperty({ example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
  @IsString()
  @IsNotEmpty()
  @Matches(/^https?:\/\//i, { message: "url must start with http(s)" })
  url!: string;
}
