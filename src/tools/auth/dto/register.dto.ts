import { IsOptional, IsString, Length, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RegisterDto {
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
  @MaxLength(255)
  deviceId?: string;
}
