import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { MovieDto } from "./movie.dto";

export class CommentDto extends MovieDto {
  @ApiPropertyOptional({ description: "Episode UUID if commenting on an episode" })
  @IsOptional()
  @IsUUID()
  episodeId?: string;

  @ApiPropertyOptional({ description: "Parent comment UUID if replying" })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiProperty({ description: "Comment content", maxLength: 5000 })
  @IsString()
  @MaxLength(5000)
  content!: string;

  @ApiPropertyOptional({ description: "Mark as containing spoilers" })
  @IsOptional()
  @IsBoolean()
  isSpoil?: boolean;
}
