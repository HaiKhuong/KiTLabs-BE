import { applyDecorators, UseGuards } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { PlatformAdminGuard } from "./platform-admin.guard";

export const PlatformAdminAccess = () =>
  applyDecorators(
    Public(),
    ApiBearerAuth("film-bearer"),
    UseGuards(PlatformAdminGuard),
  );
