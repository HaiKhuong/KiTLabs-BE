import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "./common/decorators/public.decorator";

@ApiTags("System")
@Controller()
export class AppController {
  @Public()
  @ApiOperation({ summary: "Health check" })
  @Get("health")
  health() {
    return {
      status: "ok",
      service: "KiTools BE",
      timestamp: new Date().toISOString(),
    };
  }
}
