import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class GenerateShortVideoSpecDto {
  @ApiProperty({
    example: "So sánh World Cup và Euro",
    description: "Chủ đề dùng để Gemini tạo ShortVideo JSON spec",
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  topic!: string;
}
