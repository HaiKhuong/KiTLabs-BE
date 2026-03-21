import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsString, IsUUID } from "class-validator";

export class DownloadVideosDto {
  @ApiProperty({ description: "Array of video download IDs", type: [String] })
  @IsArray()
  @IsUUID("4", { each: true })
  videoIds!: string[];

  @ApiProperty({ description: "User ID" })
  @IsString()
  userId!: string;
}
