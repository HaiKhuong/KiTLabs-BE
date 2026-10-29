import { ApiProperty } from "@nestjs/swagger";
import { IsEnum } from "class-validator";
import { ReactionType } from "../../../entities/film.entities";

export class ReactionDto {
  @ApiProperty({ description: "Reaction type (LIKE / DISLIKE)", enum: ReactionType })
  @IsEnum(ReactionType)
  type!: ReactionType;
}
