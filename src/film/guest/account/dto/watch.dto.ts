import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsUUID, Min } from "class-validator";

export class WatchDto {
  @ApiProperty({ description: "Movie UUID" })
  @IsUUID()
  movieId!: string;

  @ApiProperty({ description: "Episode UUID" })
  @IsUUID()
  episodeId!: string;

  @ApiProperty({ description: "Stopped playback time in seconds" })
  @IsInt()
  @Min(0)
  stoppedAtSeconds!: number;

  @ApiProperty({ description: "Total minutes watched" })
  @IsInt()
  @Min(0)
  watchedMinutes!: number;
}
