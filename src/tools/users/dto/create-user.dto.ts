import { IsNotEmpty, IsOptional, IsString, Length } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateUserDto {
  @ApiProperty({ example: "demo_user" })
  @IsString()
  @Length(3, 100)
  userName!: string;

  @ApiProperty({ example: "P@ssw0rd123" })
  @IsString()
  @Length(8, 255)
  password!: string;

  @ApiPropertyOptional({ example: "device-abc-123" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  deviceId?: string;

  @ApiPropertyOptional({ example: "192.168.1.10" })
  @IsOptional()
  @IsString()
  ip?: string;

  @ApiPropertyOptional({ example: "AA:BB:CC:DD:EE:FF" })
  @IsOptional()
  @IsString()
  mac?: string;
}
