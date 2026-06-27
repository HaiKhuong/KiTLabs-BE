import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";
import { Type } from "class-transformer";

export class InitUploadDto {
  @ApiProperty({ example: "movie.mp4" })
  @IsNotEmpty()
  @IsString()
  filename!: string;

  @ApiProperty({ example: 5368709120, description: "Total file size in bytes" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  size!: number;

  @ApiPropertyOptional({ example: 20971520, description: "Chunk size in bytes (default 20MB)" })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  chunkSize?: number;

  @ApiPropertyOptional({ example: "videos" })
  @IsOptional()
  @IsString()
  folder?: string;

  @ApiPropertyOptional({ example: "user-abc-123" })
  @IsOptional()
  @IsString()
  userId?: string;
}

export class CompleteUploadDto {
  @ApiProperty({ example: "e4a32ab8" })
  @IsNotEmpty()
  @IsString()
  uploadId!: string;
}

export class CancelUploadDto {
  @ApiProperty({ example: "e4a32ab8" })
  @IsNotEmpty()
  @IsString()
  uploadId!: string;
}
