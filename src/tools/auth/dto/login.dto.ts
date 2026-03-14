import { IsString, Length } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class LoginDto {
  @ApiProperty({ example: "demo_user" })
  @IsString()
  @Length(3, 100)
  userName!: string;

  @ApiProperty({ example: "P@ssw0rd123" })
  @IsString()
  @Length(8, 255)
  password!: string;
}
