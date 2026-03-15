import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class GuestAuthDto {
  @ApiPropertyOptional({ example: "device-abc-123" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceId?: string;

  @ApiPropertyOptional({ example: "192.168.1.10" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ip?: string;

  @ApiPropertyOptional({ example: "AA:BB:CC:DD:EE:FF" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  mac?: string;
}
