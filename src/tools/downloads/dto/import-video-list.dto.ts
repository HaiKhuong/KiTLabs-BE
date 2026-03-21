import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

export class ImportVideoListDto {
  @ApiProperty({ description: "Content of the txt file" })
  @IsString()
  content!: string;

  @ApiProperty({ description: "User ID" })
  @IsString()
  userId!: string;
}
