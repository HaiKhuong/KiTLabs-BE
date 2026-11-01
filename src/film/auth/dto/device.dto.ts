import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

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

  @ApiPropertyOptional({ description: "Referral user ID if visited via ?ref=" })
  @IsOptional()
  @IsString()
  ref?: string;

  @ApiPropertyOptional({ description: "Whether private browsing was detected", nullable: true })
  @IsOptional()
  @IsBoolean()
  isIncognito?: boolean | null;

  @ApiPropertyOptional({ description: "Browser reported by the incognito detector", nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  incognitoBrowser?: string | null;
}
