import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { MovieDto } from "./movie.dto";

export class RatingDto extends MovieDto {
  @ApiProperty({ description: "Score between 1 and 5", minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @ApiPropertyOptional({ description: "Optional review comment" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  review?: string;
}
