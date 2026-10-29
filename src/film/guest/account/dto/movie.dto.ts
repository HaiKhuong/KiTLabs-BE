import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class MovieDto {
  @ApiProperty({ description: "Movie UUID" })
  @IsUUID()
  movieId!: string;
}
