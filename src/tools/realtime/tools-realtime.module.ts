import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { ToolsRealtimeGateway } from "./tools-realtime.gateway";

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [ToolsRealtimeGateway],
  exports: [ToolsRealtimeGateway],
})
export class ToolsRealtimeModule {}
