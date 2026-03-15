import { IsEnum, IsNotEmpty, IsOptional, IsString, Length, MaxLength, ValidateIf } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { UserAuthType } from "../user.entity";

export class CreateUserDto {
  @ApiPropertyOptional({ enum: UserAuthType, default: UserAuthType.ACCOUNT })
  @IsOptional()
  @IsEnum(UserAuthType)
  authType?: UserAuthType;

  @ApiPropertyOptional({ example: "demo_user" })
  @ValidateIf((o: CreateUserDto) => (o.authType ?? UserAuthType.ACCOUNT) === UserAuthType.ACCOUNT)
  @IsString()
  @Length(3, 100)
  userName?: string;

  @ApiPropertyOptional({ example: "P@ssw0rd123" })
  @ValidateIf((o: CreateUserDto) => (o.authType ?? UserAuthType.ACCOUNT) === UserAuthType.ACCOUNT)
  @IsString()
  @Length(8, 255)
  password?: string;

  @ApiPropertyOptional({ example: "device-abc-123" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
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
