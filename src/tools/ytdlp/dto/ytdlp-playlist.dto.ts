import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches } from "class-validator";

export class YtdlpPlaylistDto {
  @ApiProperty({ example: "https://www.youtube.com/playlist?list=PLxxxx" })
  @IsString()
  @IsNotEmpty()
  @Matches(/^https?:\/\//i, { message: "url must start with http(s)" })
  url!: string;
}
