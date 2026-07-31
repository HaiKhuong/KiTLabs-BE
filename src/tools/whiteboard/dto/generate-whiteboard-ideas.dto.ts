import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class GenerateWhiteboardIdeasDto {
  @ApiProperty({ description: "User ID (guest or authenticated)" })
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({ description: "High-level idea / topic for the whiteboard video" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_000)
  idea!: string;
}
