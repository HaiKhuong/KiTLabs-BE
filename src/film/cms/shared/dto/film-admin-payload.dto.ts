import { ApiProperty } from "@nestjs/swagger";
import { IsObject } from "class-validator";

export class FilmAdminPayloadDto {
  @ApiProperty({ description: "Entity payload data", type: Object })
  @IsObject()
  data!: Record<string, unknown>;
}
