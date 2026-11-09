import { Body, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiParam } from "@nestjs/swagger";
import { FilmAdminPaginationQueryDto, FilmAdminPayloadDto } from "./dto";
import { FilmAdminService } from "./film-admin.service";

export { FilmAdminPaginationQueryDto, FilmAdminPayloadDto };

export abstract class FilmCrudController {
  protected abstract readonly resource: string;

  constructor(protected readonly service: FilmAdminService) {}

  @ApiOperation({ summary: "Get paginated list of resources" })
  @Get()
  list(@Query() query: FilmAdminPaginationQueryDto) {
    const filter: {
      episodeId?: string;
      movieId?: string;
      status?: string;
      deleted?: string;
      position?: string;
      search?: string;
      year?: number;
      genreId?: string;
      isHot?: string;
      isRecommended?: string;
      role?: string;
      reason?: string;
      parentId?: string;
      includeReplies?: string;
    } = {};
    if (query.episodeId) filter.episodeId = query.episodeId;
    if (query.movieId) filter.movieId = query.movieId;
    if (query.status) filter.status = query.status;
    if (query.deleted) filter.deleted = query.deleted;
    if (query.position) filter.position = query.position;
    if (query.search) filter.search = query.search;
    if (query.year) filter.year = query.year;
    if (query.genreId) filter.genreId = query.genreId;
    if (query.isHot) filter.isHot = query.isHot;
    if (query.isRecommended) filter.isRecommended = query.isRecommended;
    if (query.role) filter.role = query.role;
    if (query.reason) filter.reason = query.reason;
    if (query.parentId) filter.parentId = query.parentId;
    if (query.includeReplies) filter.includeReplies = query.includeReplies;
    return this.service.adminList(this.resource, query.page || 1, query.limit || 10, filter);
  }

  @ApiOperation({ summary: "Get resource details by ID" })
  @ApiParam({ name: "id", description: "Resource UUID" })
  @Get(":id")
  one(@Param("id") id: string) {
    return this.service.adminOne(this.resource, id);
  }

  @ApiOperation({ summary: "Create new resource record" })
  @Post()
  create(@Body() dto: FilmAdminPayloadDto) {
    return this.service.adminCreate(this.resource, this.safe(dto.data));
  }

  @ApiOperation({ summary: "Update resource record by ID" })
  @ApiParam({ name: "id", description: "Resource UUID" })
  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: FilmAdminPayloadDto) {
    const data = this.safe(dto.data);
    return this.resource === "donations"
      ? this.service.updateDonation(id, data)
      : this.service.adminUpdate(this.resource, id, data);
  }

  @ApiOperation({ summary: "Soft delete resource record by ID" })
  @ApiParam({ name: "id", description: "Resource UUID" })
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.service.adminDelete(this.resource, id);
  }

  @ApiOperation({ summary: "Restore soft-deleted resource record by ID" })
  @ApiParam({ name: "id", description: "Resource UUID" })
  @Post(":id/restore")
  restore(@Param("id") id: string) {
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
    ]) {
      delete copy[key];
    }
    return copy;
  }
}
