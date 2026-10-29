import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class AdminLoginDto {
  @ApiProperty({ description: "Email or username of admin" })
  @IsString()
  @MinLength(3)
  email!: string;

  @ApiProperty({ description: "Password" })
  @IsString()
  @MinLength(6)
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ description: "Refresh token" })
  @IsString()
  refreshToken!: string;
}

export class DeviceDto {
  @ApiPropertyOptional({ description: "Existing device UUID token" })
  @IsOptional()
  @IsUUID()
  deviceToken?: string;
}

export class UpdateFilmProfileDto {
  @ApiPropertyOptional({ description: "Tên hiển thị của người dùng" })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name?: string;
}

