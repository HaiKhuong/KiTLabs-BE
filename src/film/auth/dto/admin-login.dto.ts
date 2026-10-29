import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength } from "class-validator";

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
