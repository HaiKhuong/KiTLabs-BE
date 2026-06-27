import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, IsEnum, IsInt, IsArray, Min } from "class-validator";

import { MovieStatus, MoviePriority } from "../entities/movie.entity";

export class CreateMovieDto {
  @ApiProperty()
  @IsString()
  chineseName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vietnameseName?: string;

  @ApiPropertyOptional({ enum: MovieStatus })
  @IsOptional()
  @IsEnum(MovieStatus)
  status?: MovieStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  episodes?: number;

  @ApiPropertyOptional({ enum: MoviePriority })
  @IsOptional()
  @IsEnum(MoviePriority)
  priority?: MoviePriority;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateMovieDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  chineseName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vietnameseName?: string;

  @ApiPropertyOptional({ enum: MovieStatus })
  @IsOptional()
  @IsEnum(MovieStatus)
  status?: MovieStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  episodes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  currentEpisode?: number;

  @ApiPropertyOptional({ enum: MoviePriority })
  @IsOptional()
  @IsEnum(MoviePriority)
  priority?: MoviePriority;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class MovieFilterDto {
  @ApiPropertyOptional({ enum: MovieStatus })
  @IsOptional()
  @IsEnum(MovieStatus)
  status?: MovieStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: MoviePriority })
  @IsOptional()
  @IsEnum(MoviePriority)
  priority?: MoviePriority;
}
