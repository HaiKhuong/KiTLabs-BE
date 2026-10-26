import { Body, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";
import { IsObject } from "class-validator";
import { FilmService } from "../../film.service";

export class FilmAdminPayloadDto {
  @ApiProperty({ type: Object }) @IsObject() data!: Record<string, unknown>;
}

export abstract class FilmCrudController {
  protected abstract readonly resource: string;
  constructor(protected readonly service: FilmService) {}
  @Get() list(@Query("page") page?: string, @Query("limit") limit?: string) {
    return this.service.adminList(this.resource, Number(page) || 1, Number(limit) || 20);
  }
  @Get(":id") one(@Param("id") id: string) {
    return this.service.adminOne(this.resource, id);
  }
  @Post() create(@Body() dto: FilmAdminPayloadDto) {
    return this.service.adminCreate(this.resource, this.safe(dto.data));
  }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: FilmAdminPayloadDto) {
    const data = this.safe(dto.data);
    return this.resource === "donations"
      ? this.service.updateDonation(id, data)
      : this.service.adminUpdate(this.resource, id, data);
  }
  @Delete(":id") remove(@Param("id") id: string) {
    return this.service.adminDelete(this.resource, id);
  }
  @Post(":id/restore") restore(@Param("id") id: string) {
    return this.service.adminRestore(this.resource, id);
  }
  private safe(data: Record<string, unknown>) {
    const copy = { ...data };
    for (const key of [
      "passwordHash",
      "password_hash",
      "refreshTokenHash",
      "refresh_token_hash",
      "scriptCode",
      "script_code",
      "id",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ])
      delete copy[key];
    return copy;
  }
}
