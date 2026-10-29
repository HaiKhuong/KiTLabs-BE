import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsObject, IsOptional, Max, Min } from "class-validator";

export class FilmAdminPaginationQueryDto {
  @ApiPropertyOptional({ description: "Page number, starting from 1", default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: "Number of records per page", default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class FilmAdminPayloadDto {
  @ApiProperty({ description: "Entity payload data", type: Object })
  @IsObject()
  data!: Record<string, unknown>;
}

