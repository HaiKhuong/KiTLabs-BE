import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

export class UpdateVideoFilenameDto {
  @ApiProperty({ description: "New filename" })
  @IsString()
  fileName!: string;
}
