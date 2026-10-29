import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID } from "class-validator";

export class DeviceDto {
  @ApiPropertyOptional({ description: "Existing device UUID token" })
  @IsOptional()
  @IsUUID()
  deviceToken?: string;

  @ApiPropertyOptional({ description: "Client IP address" })
  @IsOptional()
  @IsString()
  ip?: string;

  @ApiPropertyOptional({ description: "Client User-Agent" })
  @IsOptional()
  @IsString()
  userAgent?: string;

  @ApiPropertyOptional({ description: "Current User ID if already authenticated" })
  @IsOptional()
  @IsString()
  userId?: string;
}
